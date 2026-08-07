import { RULES } from "../config/rules";
import type { Tick } from "../domain/types";
import type { MonotonicClock } from "./clock";
import {
  envelopeStream,
  isCriticalKind,
  streamKey,
  type CriticalKind,
  type CriticalPayload,
  type MessageKind,
  type RealtimeEnvelope,
  type RealtimePayloadMap,
  type StreamCursor,
  type StreamRef,
} from "./messages";

interface OutboxEntry {
  envelope: RealtimeEnvelope<CriticalKind>;
  lastSentMs: number;
}

interface InboundState {
  stream: StreamRef;
  nextExpected: number;
  buffered: Map<number, RealtimeEnvelope<CriticalKind>>;
  gapRequest: {
    fromSeq: number;
    lastSentMs: number;
  } | null;
}

interface GapResendWindow {
  fromSeq: number;
  throughSeq: number;
  lastSentMs: number;
}

export interface CriticalReliabilityOptions {
  matchId: string;
  identity: StreamRef;
  peer: StreamRef;
  clock: MonotonicClock;
  getMatchTick: () => Tick;
  send: (envelope: RealtimeEnvelope) => void;
  apply: (envelope: RealtimeEnvelope<CriticalKind>) => void;
  maxPending?: number;
  retryMs?: number;
}

export interface PeerLivenessOptions {
  clock: MonotonicClock;
  peer: StreamRef;
  unstablePeerMs?: number;
  missingPeerMs?: number;
}

function sameStream(left: StreamRef, right: StreamRef): boolean {
  return left.senderId === right.senderId && left.sessionId === right.sessionId;
}

function criticalEventId(envelope: RealtimeEnvelope<CriticalKind>): string {
  return (envelope.payload as CriticalPayload).eventId;
}

export class PeerLiveness {
  private peer: StreamRef;
  private lastTrafficMs: number;
  private readonly unstablePeerMs: number;
  private readonly missingPeerMs: number;

  public constructor(private readonly options: PeerLivenessOptions) {
    this.peer = options.peer;
    this.lastTrafficMs = options.clock.now();
    this.unstablePeerMs =
      options.unstablePeerMs ?? RULES.network.unstablePeerMs;
    this.missingPeerMs = options.missingPeerMs ?? RULES.network.missingPeerMs;
    if (this.unstablePeerMs >= this.missingPeerMs) {
      throw new RangeError("Peer instability threshold must precede missing threshold");
    }
  }

  public bindPeer(peer: StreamRef): void {
    this.peer = peer;
    this.lastTrafficMs = this.options.clock.now();
  }

  public observe(envelope: RealtimeEnvelope): boolean {
    if (!sameStream(envelopeStream(envelope), this.peer)) return false;
    if (
      envelope.kind === "KEEPALIVE" &&
      envelope.payload.activeSessionId !== this.peer.sessionId
    ) {
      return false;
    }
    this.lastTrafficMs = this.options.clock.now();
    return true;
  }

  public isMissing(): boolean {
    return this.options.clock.now() - this.lastTrafficMs >= this.missingPeerMs;
  }

  public isUnstable(): boolean {
    return this.options.clock.now() - this.lastTrafficMs >= this.unstablePeerMs;
  }

  public remainingMs(): number {
    return Math.max(
      0,
      this.missingPeerMs - (this.options.clock.now() - this.lastTrafficMs),
    );
  }

  public silentForMs(): number {
    return Math.max(0, this.options.clock.now() - this.lastTrafficMs);
  }
}

export class CriticalReliability {
  private readonly outbox = new Map<number, OutboxEntry>();
  private readonly outboundEventSeq = new Map<string, number>();
  private readonly inbound = new Map<string, InboundState>();
  private gapResendWindows: GapResendWindow[] = [];
  private readonly appliedEventIds = new Set<string>();
  private readonly appliedEventOrder: string[] = [];
  private nextSequence = 1;
  private connected = true;
  private peer: StreamRef;
  private readonly maxPending: number;
  private readonly retryMs: number;

  public constructor(private readonly options: CriticalReliabilityOptions) {
    this.peer = options.peer;
    this.maxPending = options.maxPending ?? RULES.network.maxPendingCritical;
    this.retryMs = options.retryMs ?? RULES.network.retryMs;
  }

  public get pendingCount(): number {
    return this.outbox.size;
  }

  public isEventPending(eventId: string): boolean {
    const sequence = this.outboundEventSeq.get(eventId);
    return sequence !== undefined && this.outbox.has(sequence);
  }

  public setConnected(connected: boolean): void {
    this.connected = connected;
  }

  public pendingEnvelopes(): readonly RealtimeEnvelope<CriticalKind>[] {
    return [...this.outbox.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, entry]) => entry.envelope);
  }

  public inboundCursors(): StreamCursor[] {
    return [...this.inbound.values()].map((state) => ({
      stream: { ...state.stream },
      contiguousThrough: state.nextExpected - 1,
    }));
  }

  public acknowledgeCursor(cursor: StreamCursor): void {
    if (!sameStream(cursor.stream, this.options.identity)) return;
    if (!Number.isSafeInteger(cursor.contiguousThrough) || cursor.contiguousThrough < 0) {
      return;
    }
    for (const sequence of [...this.outbox.keys()]) {
      if (sequence <= cursor.contiguousThrough) this.acknowledgeSequence(sequence);
    }
  }

  public bindPeer(peer: StreamRef): void {
    this.peer = peer;
  }

  public sendCritical<K extends CriticalKind>(
    kind: K,
    payload: RealtimePayloadMap[K],
    matchTick: Tick,
  ): RealtimeEnvelope<K> {
    const eventId = (payload as CriticalPayload).eventId;
    if (typeof eventId !== "string" || eventId.length === 0) {
      throw new TypeError("Critical events require a semantic event ID");
    }
    const existingSequence = this.outboundEventSeq.get(eventId);
    if (existingSequence !== undefined) {
      const existing = this.outbox.get(existingSequence);
      if (existing !== undefined) return existing.envelope as RealtimeEnvelope<K>;
    }
    if (this.outbox.size >= this.maxPending) {
      throw new RangeError("Critical outbox capacity exceeded");
    }

    const envelope = {
      protocol: 1,
      matchId: this.options.matchId,
      senderId: this.options.identity.senderId,
      sessionId: this.options.identity.sessionId,
      kind,
      seq: this.nextSequence,
      matchTick,
      sentAtMonotonicMs: this.options.clock.now(),
      payload,
    } as RealtimeEnvelope<K>;
    this.nextSequence += 1;
    const erased = envelope as RealtimeEnvelope<CriticalKind>;
    this.outbox.set(envelope.seq!, {
      envelope: erased,
      lastSentMs: this.options.clock.now(),
    });
    this.outboundEventSeq.set(eventId, envelope.seq!);
    this.options.send(envelope);
    return envelope;
  }

  public receive(envelope: RealtimeEnvelope): void {
    if (
      envelope.matchId !== this.options.matchId ||
      !sameStream(envelopeStream(envelope), this.peer)
    ) {
      return;
    }
    if (envelope.kind === "ACK") {
      this.receiveAck(envelope as RealtimeEnvelope<"ACK">);
      return;
    }
    if (envelope.kind === "GAP_REQUEST") {
      this.receiveGapRequest(envelope as RealtimeEnvelope<"GAP_REQUEST">);
      return;
    }
    if (isCriticalKind(envelope.kind)) {
      this.receiveCritical(envelope as RealtimeEnvelope<CriticalKind>);
    }
  }

  public pump(): void {
    if (!this.connected) return;
    const now = this.options.clock.now();
    for (const entry of this.outbox.values()) {
      if (now - entry.lastSentMs < this.retryMs) continue;
      entry.lastSentMs = now;
      this.options.send(entry.envelope);
    }
  }

  private receiveAck(envelope: RealtimeEnvelope<"ACK">): void {
    if (!sameStream(envelope.payload.stream, this.options.identity)) return;
    for (const sequence of envelope.payload.seqs) {
      this.acknowledgeSequence(sequence);
    }
  }

  private receiveGapRequest(envelope: RealtimeEnvelope<"GAP_REQUEST">): void {
    if (!sameStream(envelope.payload.stream, this.options.identity)) return;
    const span = envelope.payload.throughSeq - envelope.payload.fromSeq + 1;
    if (span <= 0 || span > this.maxPending) return;
    const now = this.options.clock.now();
    this.gapResendWindows = this.gapResendWindows.filter(
      (window) => now - window.lastSentMs < this.retryMs,
    );
    const entries: OutboxEntry[] = [];
    for (
      let sequence = envelope.payload.fromSeq;
      sequence <= envelope.payload.throughSeq;
      sequence += 1
    ) {
      const entry = this.outbox.get(sequence);
      if (entry === undefined) continue;
      entries.push(entry);
    }
    if (entries.length === 0) return;
    if (this.gapResendWindows.some(
      (window) =>
        envelope.payload.fromSeq <= window.throughSeq &&
        envelope.payload.throughSeq >= window.fromSeq,
    )) {
      return;
    }
    // Commit the rate limit before crossing a potentially re-entrant transport.
    // Older peers may request overlapping ranges for every buffered future
    // frame; remembering every recently covered range prevents those requests
    // from recursively amplifying one loss into a retransmission storm.
    this.gapResendWindows.push({
      fromSeq: envelope.payload.fromSeq,
      throughSeq: envelope.payload.throughSeq,
      lastSentMs: now,
    });
    while (this.gapResendWindows.length > this.maxPending) {
      this.gapResendWindows.shift();
    }
    for (const entry of entries) {
      entry.lastSentMs = now;
      this.options.send(entry.envelope);
    }
  }

  private receiveCritical(envelope: RealtimeEnvelope<CriticalKind>): void {
    const sequence = envelope.seq;
    if (!Number.isSafeInteger(sequence) || sequence === undefined || sequence < 1) return;
    const key = streamKey(envelopeStream(envelope));
    let state = this.inbound.get(key);
    if (state === undefined) {
      state = {
        stream: envelopeStream(envelope),
        nextExpected: 1,
        buffered: new Map(),
        gapRequest: null,
      };
      this.inbound.set(key, state);
    }

    if (sequence < state.nextExpected) {
      this.sendAck(envelopeStream(envelope), [sequence]);
      return;
    }
    if (sequence > state.nextExpected) {
      if (sequence - state.nextExpected >= this.maxPending) return;
      if (state.buffered.size >= this.maxPending) {
        throw new RangeError("Critical gap buffer capacity exceeded");
      }
      state.buffered.set(sequence, envelope);
      this.requestMissingPrefix(state);
      return;
    }

    const acknowledged: number[] = [];
    let current: RealtimeEnvelope<CriticalKind> | undefined = envelope;
    while (current !== undefined) {
      const currentSequence = current.seq!;
      const eventId = criticalEventId(current);
      const shouldApply = !this.appliedEventIds.has(eventId);
      // Commit the cursor and semantic ID before invoking application code. A
      // synchronous broadcast transport may re-enter receive() from callbacks.
      if (shouldApply) this.rememberAppliedEvent(eventId);
      acknowledged.push(currentSequence);
      state.nextExpected = currentSequence + 1;
      state.gapRequest = null;
      state.buffered.delete(currentSequence);
      if (shouldApply) this.options.apply(current);
      current = state.buffered.get(state.nextExpected);
    }
    this.sendAck(envelopeStream(envelope), acknowledged);
    this.requestMissingPrefix(state);
  }

  private requestMissingPrefix(state: InboundState): void {
    let firstBufferedSequence: number | null = null;
    for (const sequence of state.buffered.keys()) {
      firstBufferedSequence = Math.min(
        firstBufferedSequence ?? sequence,
        sequence,
      );
    }
    if (
      firstBufferedSequence === null ||
      firstBufferedSequence <= state.nextExpected
    ) {
      state.gapRequest = null;
      return;
    }
    const now = this.options.clock.now();
    if (
      state.gapRequest?.fromSeq === state.nextExpected &&
      now - state.gapRequest.lastSentMs < this.retryMs
    ) {
      return;
    }
    state.gapRequest = { fromSeq: state.nextExpected, lastSentMs: now };
    this.sendControl("GAP_REQUEST", {
      stream: state.stream,
      fromSeq: state.nextExpected,
      throughSeq: firstBufferedSequence - 1,
    });
  }

  private sendAck(stream: StreamRef, sequences: number[]): void {
    this.sendControl("ACK", { stream, seqs: sequences });
  }

  private acknowledgeSequence(sequence: number): void {
    const entry = this.outbox.get(sequence);
    if (entry === undefined) return;
    this.outbox.delete(sequence);
    this.gapResendWindows = this.gapResendWindows.filter((window) => {
      for (
        let pendingSequence = window.fromSeq;
        pendingSequence <= window.throughSeq;
        pendingSequence += 1
      ) {
        if (this.outbox.has(pendingSequence)) return true;
      }
      return false;
    });
    this.outboundEventSeq.delete(criticalEventId(entry.envelope));
  }

  private rememberAppliedEvent(eventId: string): void {
    this.appliedEventIds.add(eventId);
    this.appliedEventOrder.push(eventId);
    const maximum = this.maxPending * 4;
    while (this.appliedEventOrder.length > maximum) {
      const expired = this.appliedEventOrder.shift();
      if (expired !== undefined) this.appliedEventIds.delete(expired);
    }
  }

  private sendControl<K extends "ACK" | "GAP_REQUEST">(
    kind: K,
    payload: RealtimePayloadMap[K],
  ): void {
    const envelope = {
      protocol: 1,
      matchId: this.options.matchId,
      senderId: this.options.identity.senderId,
      sessionId: this.options.identity.sessionId,
      kind,
      matchTick: this.options.getMatchTick(),
      sentAtMonotonicMs: this.options.clock.now(),
      payload,
    } as RealtimeEnvelope<K>;
    this.options.send(envelope);
  }
}
