import { RULES } from "../config/rules";
import type { Tick } from "../domain/types";
import type { MonotonicClock } from "./clock";
import { RoundTripEstimator } from "./rtt-estimator";
import {
  envelopeStream,
  isCriticalKind,
  streamKey,
  type CriticalApplicationOutcome,
  type CriticalApplicationReceipt,
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
  firstSentMs: number;
  lastSentMs: number;
  retryAfterMs: number;
  retransmitted: boolean;
}

interface InboundState {
  stream: StreamRef;
  nextExpected: number;
  buffered: Map<number, RealtimeEnvelope<CriticalKind>>;
  gapRequest: {
    fromSeq: number;
    lastSentMs: number;
  } | null;
  applicationReceipts: Map<number, CriticalApplicationReceipt>;
  applicationReceiptOrder: number[];
}

interface GapResendWindow {
  fromSeq: number;
  throughSeq: number;
  lastSentMs: number;
}

export interface CriticalAcknowledgement {
  readonly eventId: string;
  readonly sequence: number;
  readonly kind: CriticalKind;
  readonly source: "ack" | "cursor";
  /** Peer's monotonic send time for the ACK or cursor-bearing envelope. */
  readonly peerAcknowledgedAtMonotonicMs?: number;
  /** Receiver's original semantic decision for critical kinds that require it. */
  readonly applicationReceipt?: CriticalApplicationReceipt;
}

export interface CriticalReliabilityOptions {
  matchId: string;
  identity: StreamRef;
  peer: StreamRef;
  clock: MonotonicClock;
  getMatchTick: () => Tick;
  send: (envelope: RealtimeEnvelope) => void;
  apply: (
    envelope: RealtimeEnvelope<CriticalKind>,
    processedAtMonotonicMs: number,
  ) => CriticalApplicationOutcome | void;
  onAcknowledged?: (acknowledgement: CriticalAcknowledgement) => void;
  onRoundTrip?: (milliseconds: number) => void;
  onRetransmit?: () => void;
  onGapRequest?: () => void;
  /** Kinds whose outbox entries cannot be retired by a cumulative cursor. */
  requireApplicationReceiptKinds?: readonly CriticalKind[];
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

// A conservative first RTO lets a high-latency path produce one unambiguous
// sample; subsequent entries use the estimator below instead of a fixed timer.
export const CRITICAL_INITIAL_RETRANSMIT_MS = 1_000;
const MAX_RETRANSMIT_MS = 8_000;
const DEFAULT_RESEND_BUDGET_PER_PUMP = 16;

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
  private readonly roundTripEstimator = new RoundTripEstimator();
  private retransmitTimeoutMs = CRITICAL_INITIAL_RETRANSMIT_MS;
  private lastResentSequence = 0;
  private resendBudgetRemaining = DEFAULT_RESEND_BUDGET_PER_PUMP;
  private requireApplicationReceiptKinds: ReadonlySet<CriticalKind>;

  public constructor(private readonly options: CriticalReliabilityOptions) {
    this.peer = options.peer;
    this.maxPending = options.maxPending ?? RULES.network.maxPendingCritical;
    this.retryMs = options.retryMs ?? RULES.network.retryMs;
    this.requireApplicationReceiptKinds = new Set(
      options.requireApplicationReceiptKinds ?? [],
    );
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

  public setRequiredApplicationReceiptKinds(
    kinds: readonly CriticalKind[],
  ): void {
    this.requireApplicationReceiptKinds = new Set(kinds);
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

  public acknowledgeCursor(
    cursor: StreamCursor,
    peerAcknowledgedAtMonotonicMs?: number,
  ): void {
    if (!sameStream(cursor.stream, this.options.identity)) return;
    if (!Number.isSafeInteger(cursor.contiguousThrough) || cursor.contiguousThrough < 0) {
      return;
    }
    const acknowledged: CriticalAcknowledgement[] = [];
    for (const sequence of [...this.outbox.keys()]) {
      if (sequence > cursor.contiguousThrough) continue;
      const entry = this.outbox.get(sequence);
      if (
        entry !== undefined &&
        this.requireApplicationReceiptKinds.has(entry.envelope.kind)
      ) {
        continue;
      }
      const notification = this.acknowledgeSequence(
        sequence,
        "cursor",
        peerAcknowledgedAtMonotonicMs,
      );
      if (notification !== null) acknowledged.push(notification);
    }
    for (const notification of acknowledged) {
      this.options.onAcknowledged?.(notification);
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
    const firstSentMs = this.options.clock.now();
    this.outbox.set(envelope.seq!, {
      envelope: erased,
      firstSentMs,
      lastSentMs: firstSentMs,
      retryAfterMs: Math.max(this.retransmitTimeoutMs, this.retryMs),
      retransmitted: false,
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
    this.resendBudgetRemaining = DEFAULT_RESEND_BUDGET_PER_PUMP;
    const pending = [...this.outbox.entries()];
    const firstAfterCursor = pending.findIndex(
      ([sequence]) => sequence > this.lastResentSequence,
    );
    const ordered =
      firstAfterCursor <= 0
        ? pending
        : [
            ...pending.slice(firstAfterCursor),
            ...pending.slice(0, firstAfterCursor),
          ];
    for (const [sequence, entry] of ordered) {
      if (now - entry.lastSentMs < entry.retryAfterMs) continue;
      if (this.resendBudgetRemaining === 0) break;
      this.resendBudgetRemaining -= 1;
      this.retransmit(entry, now);
      this.lastResentSequence = sequence;
    }
  }

  private receiveAck(envelope: RealtimeEnvelope<"ACK">): void {
    if (!sameStream(envelope.payload.stream, this.options.identity)) return;
    const applicationReceipts = new Map(
      (envelope.payload.applicationReceipts ?? []).map((receipt) => [
        receipt.sequence,
        receipt,
      ]),
    );
    const acknowledged: CriticalAcknowledgement[] = [];
    for (const sequence of envelope.payload.seqs) {
      const entry = this.outbox.get(sequence);
      const applicationReceipt = applicationReceipts.get(sequence);
      if (
        entry !== undefined &&
        this.requireApplicationReceiptKinds.has(entry.envelope.kind) &&
        applicationReceipt === undefined
      ) {
        continue;
      }
      const notification = this.acknowledgeSequence(
        sequence,
        "ack",
        envelope.sentAtMonotonicMs,
        applicationReceipt,
      );
      if (notification !== null) acknowledged.push(notification);
    }
    for (const notification of acknowledged) {
      this.options.onAcknowledged?.(notification);
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
    const batch = entries.slice(0, this.resendBudgetRemaining);
    const first = batch[0];
    const last = batch[batch.length - 1];
    if (first === undefined || last === undefined) return;
    this.resendBudgetRemaining -= batch.length;
    this.gapResendWindows.push({
      fromSeq: first.envelope.seq!,
      throughSeq: last.envelope.seq!,
      lastSentMs: now,
    });
    while (this.gapResendWindows.length > this.maxPending) {
      this.gapResendWindows.shift();
    }
    for (const entry of batch) {
      this.retransmit(entry, now);
    }
  }

  private retransmit(entry: OutboxEntry, now: number): void {
    entry.lastSentMs = now;
    entry.retransmitted = true;
    entry.retryAfterMs = Math.min(
      entry.retryAfterMs * 2,
      MAX_RETRANSMIT_MS,
    );
    this.options.send(entry.envelope);
    this.options.onRetransmit?.();
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
        applicationReceipts: new Map(),
        applicationReceiptOrder: [],
      };
      this.inbound.set(key, state);
    }

    if (sequence < state.nextExpected) {
      const receipt = state.applicationReceipts.get(sequence);
      this.sendAck(
        envelopeStream(envelope),
        [sequence],
        receipt === undefined ? [] : [receipt],
      );
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
    const applicationReceipts: CriticalApplicationReceipt[] = [];
    let current: RealtimeEnvelope<CriticalKind> | undefined = envelope;
    while (current !== undefined) {
      const currentSequence = current.seq!;
      const eventId = criticalEventId(current);
      const shouldApply = !this.appliedEventIds.has(eventId);
      const processedAtMonotonicMs = this.options.clock.now();
      // Commit the cursor and semantic ID before invoking application code. A
      // synchronous broadcast transport may re-enter receive() from callbacks.
      if (shouldApply) this.rememberAppliedEvent(eventId);
      acknowledged.push(currentSequence);
      state.nextExpected = currentSequence + 1;
      state.gapRequest = null;
      state.buffered.delete(currentSequence);
      if (shouldApply) {
        const outcome = this.options.apply(current, processedAtMonotonicMs);
        if (outcome !== undefined) {
          const receipt: CriticalApplicationReceipt = {
            sequence: currentSequence,
            outcome,
            processedAtMonotonicMs,
          };
          this.rememberApplicationReceipt(state, receipt);
          applicationReceipts.push(receipt);
        }
      }
      current = state.buffered.get(state.nextExpected);
    }
    this.sendAck(
      envelopeStream(envelope),
      acknowledged,
      applicationReceipts,
    );
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
    this.options.onGapRequest?.();
  }

  private sendAck(
    stream: StreamRef,
    sequences: number[],
    applicationReceipts: CriticalApplicationReceipt[] = [],
  ): void {
    this.sendControl("ACK", {
      stream,
      seqs: sequences,
      ...(applicationReceipts.length === 0
        ? {}
        : { applicationReceipts }),
    });
  }

  private acknowledgeSequence(
    sequence: number,
    source: CriticalAcknowledgement["source"],
    peerAcknowledgedAtMonotonicMs?: number,
    applicationReceipt?: CriticalApplicationReceipt,
  ): CriticalAcknowledgement | null {
    const entry = this.outbox.get(sequence);
    if (entry === undefined) return null;
    const eventId = criticalEventId(entry.envelope);
    // Karn's rule: an ACK after any retransmission cannot identify which send it
    // measured, so it must not influence the shared RTT estimator.
    if (!entry.retransmitted) this.observeRoundTrip(entry);
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
    this.outboundEventSeq.delete(eventId);
    return {
      eventId,
      sequence,
      kind: entry.envelope.kind,
      source,
      ...(peerAcknowledgedAtMonotonicMs === undefined
        ? {}
        : { peerAcknowledgedAtMonotonicMs }),
      ...(applicationReceipt === undefined
        ? {}
        : { applicationReceipt: { ...applicationReceipt } }),
    };
  }

  private observeRoundTrip(entry: OutboxEntry): void {
    const sampleMs = Math.max(0, this.options.clock.now() - entry.firstSentMs);
    this.options.onRoundTrip?.(sampleMs);
    const estimate = this.roundTripEstimator.observe(sampleMs);
    this.retransmitTimeoutMs = Math.min(
      MAX_RETRANSMIT_MS,
      Math.max(
        this.retryMs,
        Math.ceil(
          estimate.smoothedMs + Math.max(1, estimate.variationMs * 4),
        ),
      ),
    );
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

  private rememberApplicationReceipt(
    state: InboundState,
    receipt: CriticalApplicationReceipt,
  ): void {
    state.applicationReceipts.set(receipt.sequence, receipt);
    state.applicationReceiptOrder.push(receipt.sequence);
    const maximum = this.maxPending * 4;
    while (state.applicationReceiptOrder.length > maximum) {
      const expired = state.applicationReceiptOrder.shift();
      if (expired !== undefined) state.applicationReceipts.delete(expired);
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
