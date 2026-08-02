import { RULES } from "../config/rules";
import { canonicalize, hashCanonicalHex } from "../domain/hashing";
import { cloneMatchResult as cloneResult } from "../domain/results";
import {
  createSimulation,
  type Simulation,
  type SimulationCheckpoint,
  type SimulationEffect,
  type SimulationSnapshot,
} from "../domain/simulation";
import type {
  LogicalAction,
  MatchResultV1,
  PlayerId,
  PlayerResultStats,
  Tick,
} from "../domain/types";
import {
  calculateClockSample,
  MatchTickClock,
  selectClockOffset,
  type ClockSample,
  type MonotonicClock,
} from "../network/clock";
import { decodeEnvelope, encodeEnvelope } from "../network/codec";
import {
  type CriticalKind,
  type MatchConfigPayload,
  type MessageKind,
  type RealtimeEnvelope,
  type RealtimePayloadMap,
  type ResumeStatePayload,
  type StreamRef,
} from "../network/messages";
import { CriticalReliability, PeerLiveness } from "../network/reliability";
import {
  createPlayerSnapshot,
  RemoteSnapshotStore,
  SnapshotScheduler,
  type PlayerSnapshotV1,
} from "../network/snapshots";

export type CompetitiveSeat = "a" | "b";

export interface CompetitiveParticipant extends StreamRef {
  displayName: string;
}

export interface CompetitiveRealtimeTransport {
  setListener(listener: (data: Uint8Array) => void): void;
  send(data: Uint8Array): void;
  leave(): void;
}

export type CompetitivePhase =
  | "lobby"
  | "synchronizing"
  | "countdown"
  | "playing"
  | "network-pause"
  | "version-mismatch"
  | "desynchronized"
  | "finished";

export interface CompetitiveTerminalState {
  outcome: "local-win" | "peer-win" | "draw" | "desync";
  reason: "top-out" | "forfeit" | "desynchronization";
  localTopOutTick: Tick | null;
  peerTopOutTick: Tick | null;
}

export interface CompetitiveSessionOptions {
  matchId: string;
  seat: CompetitiveSeat;
  identity: CompetitiveParticipant;
  peer: CompetitiveParticipant;
  rulesHash: string;
  clock: MonotonicClock;
  transport: CompetitiveRealtimeTransport;
  createSeed?: () => string;
  onPhaseChange?: (phase: CompetitivePhase) => void;
  onForfeitWin?: (forfeitingPlayerId: PlayerId) => void;
  onRemoteBlackout?: (ownerPlayerId: PlayerId, eventId: string) => void;
  onIncomingGarbage?: (rows: number, eventId: string) => void;
  onSimulationEffects?: (effects: readonly SimulationEffect[]) => void;
  onPeerTopOut?: (playerId: PlayerId, tick: Tick) => void;
  onTerminal?: (terminal: CompetitiveTerminalState) => void;
  /**
   * Called when a result is safe to append to durable history. For normal
   * matches this fires only on Seat A after both peers confirm the same hash.
   * A connected forfeit winner may fire it alone after liveness grace expires.
   * Either peer may emit the same canonical neutral result after desynchronization.
   */
  onResultConfirmed?: (result: MatchResultV1) => void;
  onDesynchronization?: (reason: string) => void;
}

export interface CompetitiveSessionView {
  phase: CompetitivePhase;
  localReady: boolean;
  peerReady: boolean;
  peerPresent: boolean;
  peerMissing: boolean;
  matchTick: Tick;
  countdownTicks: number;
  configHash?: string;
  seed?: string;
  clockOffsetMs: number;
  clockSampleIds: readonly number[];
  local?: SimulationSnapshot;
  remote?: PlayerSnapshotV1;
  terminal?: CompetitiveTerminalState;
  result?: MatchResultV1;
}

export type ForfeitDeliveryStatus =
  | "not-started"
  | "pending"
  | "acknowledged"
  | "fallback-queued";

interface FinalPlayerClaim {
  stats: PlayerResultStats;
}

interface ResultConfirmation {
  hash: string;
  result: MatchResultV1;
}

function cloneStats(stats: PlayerResultStats): PlayerResultStats {
  return { ...stats };
}

function statsFromSnapshot(snapshot: SimulationSnapshot | PlayerSnapshotV1): PlayerResultStats {
  if ("player" in snapshot) {
    return {
      score: snapshot.player.score,
      lines: snapshot.player.lines,
      ...snapshot.player.stats,
    };
  }
  return {
    score: snapshot.score,
    lines: snapshot.lines,
    ...snapshot.stats,
  };
}

function emptyResultStats(): PlayerResultStats {
  return {
    score: 0,
    lines: 0,
    garbageSent: 0,
    powersActivated: 0,
    tetrises: 0,
    tSpinSingles: 0,
    tSpinDoubles: 0,
    tSpinTriples: 0,
  };
}

function createRandomSeed(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isSeed(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value);
}

const MAX_REMOTE_TICK_ADVANCE = Math.ceil(
  (RULES.network.missingPeerMs * RULES.timing.ticksPerSecond) / 1_000,
);
const MAX_CHECKPOINT_HISTORY = MAX_REMOTE_TICK_ADVANCE + 1;

export function competitiveConfigHash(
  rulesHash: string,
  seed: string,
  seatAPlayerId: PlayerId,
  seatBPlayerId: PlayerId,
): string {
  return hashCanonicalHex({
    rulesVersion: RULES.rulesVersion,
    rulesHash,
    seed,
    seatAPlayerId,
    seatBPlayerId,
  });
}

export class CompetitiveSession {
  private transport: CompetitiveRealtimeTransport;
  private channelConnected = true;
  private started = false;
  private phase: CompetitivePhase = "lobby";
  private localReady = false;
  private peerReady = false;
  private peerPresent = false;
  private simulation: Simulation | null = null;
  private readonly tickClock = new MatchTickClock(RULES.timing.ticksPerSecond);
  private readonly reliability: CriticalReliability;
  private readonly liveness: PeerLiveness;
  private readonly remoteSnapshots = new RemoteSnapshotStore();
  private readonly snapshotScheduler = new SnapshotScheduler();
  private snapshotSequence = 0;
  private lastKeepaliveSentMs: number;
  private scheduledStartLocalMs: number | null = null;
  private config: MatchConfigPayload | null = null;
  private clockOffsetMs = 0;
  private selectedClockSampleIds: number[] = [];
  private readonly clockSamples = new Map<number, ClockSample>();
  private readonly pingSentAt = new Map<number, number>();
  private nextClockSampleId = 1;
  private syncPurpose: "initial" | "resume" | null = null;
  private clockSyncLastAttemptMs: number | null = null;
  private clockSyncDeadlineMs: number | null = null;
  private pendingClockCommit: RealtimePayloadMap["CLOCK_COMMIT"] | null = null;
  private clockCommitLastSentMs: number | null = null;
  private clockCommitDeadlineMs: number | null = null;
  private clockCommitReceived = false;
  private pendingConfigAck: RealtimePayloadMap["CONFIG_ACK"] | null = null;
  private configAckLastSentMs: number | null = null;
  private configAckDeadlineMs: number | null = null;
  private startScheduled = false;
  private pauseEpoch = 0;
  private pauseTick: Tick = 0;
  private missingSinceMs: number | null = null;
  private localResumeSent = false;
  private remoteResumeReceived = false;
  private remoteResumeTick: Tick | null = null;
  private peerReturnNoted = false;
  private forfeitRecorded = false;
  private explicitForfeitEventId: string | null = null;
  private explicitForfeitResult: MatchResultV1 | null = null;
  private explicitForfeitFallbackQueued = false;
  private localTopOutTick: Tick | null = null;
  private peerTopOutTick: Tick | null = null;
  private terminal: CompetitiveTerminalState | null = null;
  private localFinalClaim: FinalPlayerClaim | null = null;
  private peerFinalClaim: FinalPlayerClaim | null = null;
  private localResultConfirmation: ResultConfirmation | null = null;
  private peerResultConfirmation: ResultConfirmation | null = null;
  private resultSettleAfterMs: number | null = null;
  private resultConsensusDeadlineMs: number | null = null;
  private confirmedResult: MatchResultV1 | null = null;
  private durableResultEmitted = false;
  private eventOrdinal = 0;
  private readonly allowedSenders: ReadonlySet<string>;
  private readonly simulationCheckpoints = new Map<Tick, SimulationCheckpoint>();

  public constructor(private readonly options: CompetitiveSessionOptions) {
    if (options.identity.senderId === options.peer.senderId) {
      throw new TypeError("Competitive participants must have distinct player IDs");
    }
    this.transport = options.transport;
    this.allowedSenders = new Set([options.peer.senderId]);
    this.lastKeepaliveSentMs = options.clock.now();
    this.remoteSnapshots.bind(options.peer.senderId, options.peer.sessionId);
    this.liveness = new PeerLiveness({
      clock: options.clock,
      peer: options.peer,
    });
    this.reliability = new CriticalReliability({
      matchId: options.matchId,
      identity: options.identity,
      peer: options.peer,
      clock: options.clock,
      getMatchTick: () => this.currentTick(),
      send: (envelope) => this.sendEncoded(envelope),
      apply: (envelope) => this.applyCritical(envelope),
    });
    this.installListener();
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.sendHello();
    this.sendKeepalive(true);
  }

  public setReady(ready: boolean): void {
    if (this.phase !== "lobby") return;
    this.localReady = ready;
    this.sendEnvelope("READY", { ready, rulesHash: this.options.rulesHash });
    this.maybeBeginInitialSync();
  }

  public dispatch(action: LogicalAction): SimulationEffect[] {
    if (this.phase !== "playing" || this.simulation === null) return [];
    const effects = this.simulation.dispatch(action);
    this.recordSimulationCheckpoint();
    this.publishEffects(effects);
    return effects;
  }

  public forfeit(): void {
    if (this.phase === "finished" || this.config === null) return;
    const result = this.buildExplicitForfeitResult();
    if (result === null) return;
    const eventId = this.nextEventId("forfeit");
    this.explicitForfeitEventId = eventId;
    this.explicitForfeitResult = cloneResult(result);
    this.confirmedResult = cloneResult(result);
    this.reliability.sendCritical(
      "FORFEIT",
      {
        eventId,
        forfeitingPlayerId: this.options.identity.senderId,
        resultHash: hashCanonicalHex(result),
        result: cloneResult(result),
      },
      this.currentTick(),
    );
    this.simulation?.setPaused(true);
    this.setTerminal({
      outcome: "peer-win",
      reason: "forfeit",
      localTopOutTick: this.localTopOutTick,
      peerTopOutTick: this.peerTopOutTick,
    });
    this.setPhase("finished");
  }

  public forfeitDeliveryStatus(): ForfeitDeliveryStatus {
    if (this.explicitForfeitEventId === null) return "not-started";
    if (this.explicitForfeitFallbackQueued) return "fallback-queued";
    return this.reliability.isEventPending(this.explicitForfeitEventId)
      ? "pending"
      : "acknowledged";
  }

  public queueForfeitFallback(): boolean {
    if (
      this.forfeitDeliveryStatus() !== "pending" ||
      this.explicitForfeitResult === null ||
      this.durableResultEmitted
    ) {
      return false;
    }
    this.explicitForfeitFallbackQueued = true;
    this.durableResultEmitted = true;
    this.options.onResultConfirmed?.(cloneResult(this.explicitForfeitResult));
    return true;
  }

  public pump(): void {
    if (!this.started) return;
    this.sendKeepalive(false);
    this.reliability.pump();
    this.pumpClockSync();
    this.pumpClockCommit();
    this.pumpConfigAck();

    if (this.phase === "finished") {
      this.maybeBeginResultConsensus();
      if (
        this.confirmedResult === null &&
        this.resultConsensusDeadlineMs !== null &&
        this.options.clock.now() >= this.resultConsensusDeadlineMs
      ) {
        this.resultConsensusDeadlineMs = null;
        this.desynchronize("result-consensus-timeout");
      }
      return;
    }

    if (
      this.phase === "countdown" &&
      this.scheduledStartLocalMs !== null &&
      this.options.clock.now() >= this.scheduledStartLocalMs
    ) {
      this.scheduledStartLocalMs = null;
      this.simulation?.setPaused(false);
      this.setPhase("playing");
      this.publishSnapshotIfDue();
    }

    if (this.phase === "playing") {
      this.advanceSimulation();
      if (this.liveness.isMissing()) this.enterNetworkPause(true);
    } else if (
      this.phase === "network-pause" &&
      this.channelConnected &&
      this.missingSinceMs !== null &&
      this.options.clock.now() - this.missingSinceMs >= RULES.network.reconnectGraceMs
    ) {
      this.recordForfeitWin();
    }
  }

  public disconnect(): void {
    if (!this.channelConnected) return;
    this.channelConnected = false;
    this.reliability.setConnected(false);
    this.transport.leave();
  }

  public attachTransport(transport: CompetitiveRealtimeTransport): void {
    if (this.channelConnected) throw new Error("Realtime transport is already connected");
    this.transport = transport;
    this.channelConnected = true;
    this.reliability.setConnected(true);
    this.installListener();
    this.sendHello();
    this.sendKeepalive(true);
  }

  public setHidden(hidden: boolean): void {
    if (hidden) this.enterNetworkPause(true);
    else if (this.phase === "network-pause") {
      if (this.config === null && this.simulation === null) {
        this.pauseEpoch = 0;
        this.pauseTick = 0;
        this.missingSinceMs = null;
        this.peerReturnNoted = false;
        this.setPhase("lobby");
      }
      this.sendKeepalive(true);
    }
  }

  public view(): CompetitiveSessionView {
    const countdownTicks =
      this.phase === "countdown" && this.scheduledStartLocalMs !== null
        ? Math.max(
            0,
            Math.ceil(
              ((this.scheduledStartLocalMs - this.options.clock.now()) *
                RULES.timing.ticksPerSecond) /
                1_000,
            ),
          )
        : 0;
    const local = this.simulation?.readSnapshot();
    const remote = this.remoteSnapshots.latest(this.options.peer.senderId);
    const base = {
      phase: this.phase,
      localReady: this.localReady,
      peerReady: this.peerReady,
      peerPresent: this.peerPresent,
      peerMissing: this.phase === "network-pause" || this.liveness.isMissing(),
      matchTick: local?.tick ?? 0,
      countdownTicks,
      clockOffsetMs: this.clockOffsetMs,
      clockSampleIds: [...this.selectedClockSampleIds],
    };
    return {
      ...base,
      ...(this.config === null
        ? {}
        : { configHash: this.config.configHash, seed: this.config.seed }),
      ...(local === undefined ? {} : { local }),
      ...(remote === undefined ? {} : { remote }),
      ...(this.terminal === null ? {} : { terminal: { ...this.terminal } }),
      ...(this.confirmedResult === null ? {} : { result: cloneResult(this.confirmedResult) }),
    };
  }

  private installListener(): void {
    this.transport.setListener((data) => this.receiveBytes(data));
  }

  private setPhase(phase: CompetitivePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.options.onPhaseChange?.(phase);
  }

  private desynchronize(reason: string): void {
    if (this.phase === "desynchronized") return;
    this.syncPurpose = null;
    this.simulation?.setPaused(true);
    this.localResultConfirmation = null;
    this.peerResultConfirmation = null;
    this.resultConsensusDeadlineMs = null;
    this.setTerminal({
      outcome: "desync",
      reason: "desynchronization",
      localTopOutTick: this.localTopOutTick,
      peerTopOutTick: this.peerTopOutTick,
    });
    const result = this.buildDesynchronizationResult();
    if (result !== null) this.confirmedResult = cloneResult(result);
    this.setPhase("desynchronized");
    this.options.onDesynchronization?.(reason);
    if (result !== null && !this.durableResultEmitted) {
      this.durableResultEmitted = true;
      this.options.onResultConfirmed?.(cloneResult(result));
    }
  }

  private buildDesynchronizationResult(): MatchResultV1 | null {
    if (this.config === null) return null;
    const seatA = this.seatA();
    const seatB = this.seatB();
    return {
      schema: "split-stack/result/v1",
      matchId: this.options.matchId,
      seedHash: hashCanonicalHex({ seed: this.config.seed }),
      players: [
        { id: seatA.senderId, displayName: seatA.displayName },
        { id: seatB.senderId, displayName: seatB.displayName },
      ],
      outcome: "desync",
      reason: "desynchronization",
      durationTicks: 0,
      finalLevel: 1,
      statsByPlayer: {
        [seatA.senderId]: emptyResultStats(),
        [seatB.senderId]: emptyResultStats(),
      },
      completedBy: seatA.senderId,
    };
  }

  private currentTick(): Tick {
    return this.simulation?.readSnapshot().tick ?? 0;
  }

  private nextEventId(purpose: string): string {
    this.eventOrdinal += 1;
    return `${this.options.identity.senderId}:${this.options.identity.sessionId}:${this.eventOrdinal}:${purpose}`;
  }

  private sendHello(): void {
    if (!this.started || !this.channelConnected) return;
    this.sendEnvelope("HELLO", {
      displayName: this.options.identity.displayName,
      targetSessionId: this.options.peer.sessionId,
    });
  }

  private sendEncoded(envelope: RealtimeEnvelope): void {
    if (!this.channelConnected) return;
    this.transport.send(encodeEnvelope(envelope));
  }

  private sendEnvelope<K extends MessageKind>(
    kind: K,
    payload: RealtimePayloadMap[K],
  ): void {
    const envelope = {
      protocol: 1,
      matchId: this.options.matchId,
      senderId: this.options.identity.senderId,
      sessionId: this.options.identity.sessionId,
      kind,
      matchTick: this.currentTick(),
      sentAtMonotonicMs: this.options.clock.now(),
      payload,
    } as RealtimeEnvelope<K>;
    this.sendEncoded(envelope);
  }

  private receiveBytes(data: Uint8Array): void {
    const decoded = decodeEnvelope(data, {
      expectedMatchId: this.options.matchId,
      allowedSenderIds: this.allowedSenders,
    });
    if (!decoded.ok || decoded.value.sessionId !== this.options.peer.sessionId) return;
    const envelope = decoded.value;

    if (envelope.kind === "KEEPALIVE") {
      const keepalive = envelope as RealtimeEnvelope<"KEEPALIVE">;
      if (this.liveness.observe(keepalive)) {
        for (const cursor of keepalive.payload.inboundCritical) {
          this.reliability.acknowledgeCursor(cursor);
        }
        this.notePeerReturn();
      }
    }

    switch (envelope.kind) {
      case "HELLO":
        this.receiveHello(envelope as RealtimeEnvelope<"HELLO">);
        return;
      case "READY":
        this.receiveReady(envelope as RealtimeEnvelope<"READY">);
        return;
      case "CLOCK_PING":
        this.receiveClockPing(envelope as RealtimeEnvelope<"CLOCK_PING">);
        return;
      case "CLOCK_PONG":
        this.receiveClockPong(envelope as RealtimeEnvelope<"CLOCK_PONG">);
        return;
      case "CLOCK_COMMIT":
        this.receiveClockCommit(envelope as RealtimeEnvelope<"CLOCK_COMMIT">);
        return;
      case "CONFIG_ACK":
        this.receiveConfigAck(envelope as RealtimeEnvelope<"CONFIG_ACK">);
        return;
      case "SNAPSHOT":
        this.remoteSnapshots.accept(envelope as RealtimeEnvelope<"SNAPSHOT">);
        return;
      default:
        this.reliability.receive(envelope);
    }
  }

  private receiveHello(envelope: RealtimeEnvelope<"HELLO">): void {
    if (
      envelope.payload.targetSessionId !== undefined &&
      envelope.payload.targetSessionId !== this.options.identity.sessionId
    ) {
      return;
    }
    this.peerPresent = true;
    this.notePeerReturn();
    this.maybeBeginInitialSync();
  }

  private receiveReady(envelope: RealtimeEnvelope<"READY">): void {
    this.peerReady = envelope.payload.ready;
    if (envelope.payload.rulesHash !== this.options.rulesHash) {
      this.setPhase("version-mismatch");
      return;
    }
    this.maybeBeginInitialSync();
  }

  private maybeBeginInitialSync(): void {
    if (
      this.options.seat === "a" &&
      this.phase === "lobby" &&
      this.localReady &&
      this.peerReady &&
      this.peerPresent
    ) {
      this.beginClockSync("initial");
    }
  }

  private beginClockSync(purpose: "initial" | "resume"): void {
    if (this.options.seat !== "a" || this.syncPurpose !== null) return;
    this.syncPurpose = purpose;
    this.clockSyncDeadlineMs = this.options.clock.now() + RULES.network.missingPeerMs;
    this.clockSamples.clear();
    this.pingSentAt.clear();
    if (purpose === "initial") this.setPhase("synchronizing");
    for (let index = 0; index < 5; index += 1) {
      const sampleId = this.nextClockSampleId;
      this.nextClockSampleId += 1;
      const coordinatorSentMs = this.options.clock.now();
      this.pingSentAt.set(sampleId, coordinatorSentMs);
      this.sendEnvelope("CLOCK_PING", { sampleId, coordinatorSentMs });
    }
    this.clockSyncLastAttemptMs = this.options.clock.now();
  }

  private pumpClockSync(): void {
    if (
      this.options.seat === "a" &&
      this.syncPurpose !== null &&
      this.clockSyncDeadlineMs !== null &&
      this.options.clock.now() >= this.clockSyncDeadlineMs
    ) {
      this.clockSyncLastAttemptMs = null;
      this.clockSyncDeadlineMs = null;
      this.desynchronize("clock-sync-timeout");
      return;
    }
    if (
      this.options.seat !== "a" ||
      this.syncPurpose === null ||
      this.clockSyncLastAttemptMs === null ||
      this.options.clock.now() - this.clockSyncLastAttemptMs < RULES.network.retryMs
    ) {
      return;
    }
    this.clockSyncLastAttemptMs = this.options.clock.now();
    for (const [sampleId, coordinatorSentMs] of this.pingSentAt) {
      if (!this.clockSamples.has(sampleId)) {
        this.sendEnvelope("CLOCK_PING", { sampleId, coordinatorSentMs });
      }
    }
  }

  private receiveClockPing(envelope: RealtimeEnvelope<"CLOCK_PING">): void {
    if (this.options.seat !== "b") return;
    const peerReceivedMs = this.options.clock.now();
    const peerSentMs = this.options.clock.now();
    this.sendEnvelope("CLOCK_PONG", {
      sampleId: envelope.payload.sampleId,
      coordinatorSentMs: envelope.payload.coordinatorSentMs,
      peerReceivedMs,
      peerSentMs,
    });
  }

  private receiveClockPong(envelope: RealtimeEnvelope<"CLOCK_PONG">): void {
    if (this.options.seat !== "a" || this.syncPurpose === null) return;
    const sentAt = this.pingSentAt.get(envelope.payload.sampleId);
    if (
      sentAt === undefined ||
      sentAt !== envelope.payload.coordinatorSentMs ||
      this.clockSamples.has(envelope.payload.sampleId)
    ) {
      return;
    }
    let sample: ClockSample;
    try {
      sample = calculateClockSample(
        sentAt,
        envelope.payload.peerReceivedMs,
        envelope.payload.peerSentMs,
        this.options.clock.now(),
        envelope.payload.sampleId,
      );
    } catch {
      return;
    }
    this.clockSamples.set(sample.sampleId, sample);
    if (this.clockSamples.size === 5) this.finishClockSync();
  }

  private finishClockSync(): void {
    const purpose = this.syncPurpose;
    if (purpose === null) return;
    const selected = selectClockOffset([...this.clockSamples.values()]);
    this.clockOffsetMs = 0;
    this.selectedClockSampleIds = [...selected.selectedSampleIds];
    this.syncPurpose = null;
    this.clockSyncLastAttemptMs = null;
    this.clockSyncDeadlineMs = null;
    this.pendingClockCommit = {
      offsetPeerMinusCoordinatorMs: selected.offsetPeerMinusCoordinatorMs,
      sampleIds: selected.selectedSampleIds,
    };
    this.clockCommitDeadlineMs = this.options.clock.now() + RULES.network.missingPeerMs;
    this.sendClockCommit();
    if (purpose === "initial") this.coordinatorSendConfig();
    else this.sendResumeState();
  }

  private sendClockCommit(): void {
    if (this.pendingClockCommit === null) return;
    this.clockCommitLastSentMs = this.options.clock.now();
    this.sendEnvelope("CLOCK_COMMIT", this.pendingClockCommit);
  }

  private pumpClockCommit(): void {
    if (this.options.seat !== "a" || this.pendingClockCommit === null) return;
    if (
      this.clockCommitDeadlineMs !== null &&
      this.options.clock.now() >= this.clockCommitDeadlineMs
    ) {
      if (this.phase === "synchronizing" && this.config !== null) return;
      this.pendingClockCommit = null;
      this.clockCommitLastSentMs = null;
      this.clockCommitDeadlineMs = null;
      this.desynchronize("clock-commit-timeout");
      return;
    }
    if (
      this.clockCommitLastSentMs !== null &&
      this.options.clock.now() - this.clockCommitLastSentMs >= RULES.network.retryMs
    ) {
      this.sendClockCommit();
    }
  }

  private receiveClockCommit(envelope: RealtimeEnvelope<"CLOCK_COMMIT">): void {
    if (this.options.seat !== "b") return;
    this.clockOffsetMs = envelope.payload.offsetPeerMinusCoordinatorMs;
    this.selectedClockSampleIds = [...envelope.payload.sampleIds];
    this.clockCommitReceived = true;
    this.sendConfigAck();
    if (this.phase === "network-pause") this.sendResumeState();
  }

  private coordinatorSendConfig(): void {
    if (this.options.seat !== "a") return;
    const seed = (this.options.createSeed ?? createRandomSeed)();
    if (!isSeed(seed)) throw new TypeError("Match seed must be 128-bit hexadecimal");
    const configHash = competitiveConfigHash(
      this.options.rulesHash,
      seed,
      this.options.identity.senderId,
      this.options.peer.senderId,
    );
    const config: MatchConfigPayload = {
      eventId: this.nextEventId("config"),
      rulesVersion: 1,
      rulesHash: this.options.rulesHash,
      configHash,
      seed,
      coordinatorPlayerId: this.options.identity.senderId,
      seatAPlayerId: this.options.identity.senderId,
      seatBPlayerId: this.options.peer.senderId,
    };
    this.adoptConfig(config);
    this.configAckDeadlineMs = this.options.clock.now() + RULES.network.missingPeerMs;
    this.reliability.sendCritical("MATCH_CONFIG", config, 0);
  }

  private adoptConfig(config: MatchConfigPayload): void {
    this.config = { ...config };
    this.simulation = createSimulation({
      seed: config.seed,
      playerId: this.options.identity.senderId,
      practice: false,
    });
    this.simulation.setPaused(true);
    this.simulationCheckpoints.clear();
    this.recordSimulationCheckpoint();
  }

  private receiveConfigAck(envelope: RealtimeEnvelope<"CONFIG_ACK">): void {
    if (
      this.options.seat !== "a" ||
      this.phase !== "synchronizing" ||
      this.config === null ||
      this.startScheduled
    ) {
      return;
    }
    if (!envelope.payload.accepted || envelope.payload.configHash !== this.config.configHash) {
      this.pendingClockCommit = null;
      this.clockCommitLastSentMs = null;
      this.clockCommitDeadlineMs = null;
      this.configAckDeadlineMs = null;
      this.setPhase("version-mismatch");
      return;
    }
    this.scheduleStart(0, 0);
  }

  private scheduleStart(startTick: Tick, epoch: number): void {
    if (this.config === null || this.startScheduled) return;
    this.startScheduled = true;
    const payload: RealtimePayloadMap["START"] = {
      eventId: this.nextEventId(epoch === 0 ? "start" : "resume-start"),
      epoch,
      startAtCoordinatorMs:
        this.options.clock.now() +
        (RULES.network.resumeCountdownTicks * 1_000) / RULES.timing.ticksPerSecond,
      startTick,
      configHash: this.config.configHash,
    };
    this.reliability.sendCritical("START", payload, startTick);
    this.applyStart(payload);
  }

  private applyStart(payload: RealtimePayloadMap["START"]): void {
    if (this.config === null || payload.configHash !== this.config.configHash) {
      this.setPhase("version-mismatch");
      return;
    }
    const localStartMs =
      payload.startAtCoordinatorMs + (this.options.seat === "b" ? this.clockOffsetMs : 0);
    this.pauseTick = payload.startTick;
    this.tickClock.scheduleStart(localStartMs, payload.startTick);
    this.scheduledStartLocalMs = localStartMs;
    this.simulation?.setPaused(true);
    this.liveness.bindPeer(this.options.peer);
    this.missingSinceMs = null;
    this.startScheduled = false;
    this.localResumeSent = false;
    this.remoteResumeReceived = false;
    this.remoteResumeTick = null;
    this.peerReturnNoted = false;
    this.pendingClockCommit = null;
    this.clockCommitLastSentMs = null;
    this.clockCommitDeadlineMs = null;
    this.pendingConfigAck = null;
    this.configAckLastSentMs = null;
    this.configAckDeadlineMs = null;
    this.snapshotScheduler.reset();
    this.setPhase("countdown");
  }

  private advanceSimulation(): void {
    const simulation = this.simulation;
    if (simulation === null) return;
    const targetTick = this.tickClock.tickAt(this.options.clock.now());
    let snapshot = simulation.readSnapshot();
    while (snapshot.tick < targetTick && this.phase === "playing") {
      const effects = simulation.tick(1);
      this.recordSimulationCheckpoint();
      this.publishEffects(effects);
      if (effects.length > 0) this.options.onSimulationEffects?.(effects);
      snapshot = simulation.readSnapshot();
      this.publishSnapshotIfDue(snapshot);
    }
  }

  private publishSnapshotIfDue(
    snapshot = this.simulation?.readSnapshot(),
    force = false,
  ): void {
    if (
      snapshot === undefined ||
      (!force && !this.snapshotScheduler.claim(snapshot.tick, true))
    ) {
      return;
    }
    this.snapshotSequence += 1;
    const payload = createPlayerSnapshot({
      player: snapshot.player,
      stateTick: snapshot.tick,
      snapshotSeq: this.snapshotSequence,
      level: snapshot.level,
      ghostRow: snapshot.ghostY,
      nextFive: snapshot.preview,
      lastAppliedCritical: this.reliability.inboundCursors(),
      stateHash: snapshot.stateHash,
    });
    this.sendEnvelope("SNAPSHOT", payload);
  }

  private publishEffects(effects: readonly SimulationEffect[]): void {
    const tick = this.currentTick();
    for (const effect of effects) {
      const eventId = effect.eventId ?? this.nextEventId(effect.kind);
      if (effect.kind === "garbage-attack" && (effect.rows ?? 0) > 0) {
        this.reliability.sendCritical(
          "GARBAGE_ATTACK",
          { eventId, targetPlayerId: this.options.peer.senderId, rows: effect.rows! },
          tick,
        );
      } else if (effect.kind === "hollow-cross") {
        this.reliability.sendCritical(
          "HOLLOW_CROSS",
          { eventId, targetPlayerId: this.options.peer.senderId },
          tick,
        );
      } else if (effect.kind === "glitch-piece") {
        this.reliability.sendCritical(
          "GLITCH_PIECE",
          { eventId, targetPlayerId: this.options.peer.senderId },
          tick,
        );
      } else if (effect.kind === "scramble-start") {
        this.reliability.sendCritical(
          "SCRAMBLE_START",
          { eventId, targetPlayerId: this.options.peer.senderId },
          tick,
        );
      } else if (effect.kind === "blackout-start") {
        this.reliability.sendCritical(
          "BLACKOUT_START",
          { eventId, ownerPlayerId: this.options.identity.senderId },
          tick,
        );
      } else if (effect.kind === "top-out") {
        const snapshot = this.simulation?.readSnapshot();
        if (snapshot !== undefined) {
          this.localTopOutTick = snapshot.player.stats.topOutTick ?? tick;
          this.localFinalClaim = {
            stats: {
              ...statsFromSnapshot(snapshot),
              topOutTick: this.localTopOutTick,
            },
          };
          // Realtime frames from one sender are ordered. Force a terminal
          // snapshot immediately before TOP_OUT so renderers get the final
          // board even when the regular 10 Hz slot was not due.
          this.publishSnapshotIfDue(snapshot, true);
          this.reliability.sendCritical(
            "TOP_OUT",
            {
              eventId,
              playerId: this.options.identity.senderId,
              reason:
                snapshot.player.topOut?.reason === "garbage"
                  ? "garbage-overflow"
                  : "spawn-collision",
              stateHash: snapshot.stateHash,
              finalLevel: snapshot.level,
              finalStats: cloneStats(this.localFinalClaim.stats),
            },
            this.localTopOutTick,
          );
          this.deferResultConsensus();
          this.finishForTopOut();
        }
      }
    }
  }

  private applyCritical(envelope: RealtimeEnvelope<CriticalKind>): void {
    switch (envelope.kind) {
      case "MATCH_CONFIG":
        this.applyMatchConfig(envelope as RealtimeEnvelope<"MATCH_CONFIG">);
        return;
      case "START":
        this.applyRemoteStart(envelope as RealtimeEnvelope<"START">);
        return;
      case "GARBAGE_ATTACK": {
        const message = envelope as RealtimeEnvelope<"GARBAGE_ATTACK">;
        if (message.payload.targetPlayerId === this.options.identity.senderId) {
          this.options.onIncomingGarbage?.(
            message.payload.rows,
            message.payload.eventId,
          );
          this.simulation?.receiveGarbage(
            message.payload.rows,
            message.payload.eventId,
            message.senderId,
            message.matchTick,
          );
          this.recordSimulationCheckpoint();
        }
        return;
      }
      case "HOLLOW_CROSS": {
        const message = envelope as RealtimeEnvelope<"HOLLOW_CROSS">;
        if (message.payload.targetPlayerId === this.options.identity.senderId) {
          this.simulation?.receiveHollowCross(message.payload.eventId);
          this.recordSimulationCheckpoint();
        }
        return;
      }
      case "GLITCH_PIECE": {
        const message = envelope as RealtimeEnvelope<"GLITCH_PIECE">;
        if (message.payload.targetPlayerId === this.options.identity.senderId) {
          this.simulation?.receiveGlitch(message.payload.eventId);
          this.recordSimulationCheckpoint();
        }
        return;
      }
      case "SCRAMBLE_START": {
        const message = envelope as RealtimeEnvelope<"SCRAMBLE_START">;
        if (message.payload.targetPlayerId === this.options.identity.senderId) {
          this.simulation?.receiveScramble();
          this.recordSimulationCheckpoint();
        }
        return;
      }
      case "BLACKOUT_START": {
        const message = envelope as RealtimeEnvelope<"BLACKOUT_START">;
        this.options.onRemoteBlackout?.(
          message.payload.ownerPlayerId,
          message.payload.eventId,
        );
        return;
      }
      case "TOP_OUT": {
        const message = envelope as RealtimeEnvelope<"TOP_OUT">;
        if (
          message.payload.finalLevel !==
          Math.floor(message.matchTick / RULES.timing.levelTicks) + 1
        ) {
          return;
        }
        const terminalSnapshot = this.remoteSnapshots.latest(message.senderId);
        if (
          terminalSnapshot !== undefined &&
          terminalSnapshot.stateTick === message.matchTick &&
          terminalSnapshot.stateHash !== message.payload.stateHash
        ) {
          this.desynchronize("top-out-state-hash-mismatch");
          return;
        }
        // If this client is fractionally behind, resolve its deterministic tick
        // before freezing. That makes two independent top-outs at the same tick
        // converge to a draw regardless of delivery order.
        if (!this.advanceSimulationTo(message.matchTick)) return;
        this.peerTopOutTick = message.matchTick;
        this.peerFinalClaim = {
          stats: cloneStats(message.payload.finalStats),
        };
        this.captureLocalFinalClaim();
        this.deferResultConsensus();
        this.options.onPeerTopOut?.(message.payload.playerId, message.matchTick);
        this.finishForTopOut();
        return;
      }
      case "FORFEIT": {
        const message = envelope as RealtimeEnvelope<"FORFEIT">;
        if (
          message.payload.forfeitingPlayerId === this.options.peer.senderId &&
          this.isValidExplicitForfeit(message)
        ) {
          this.recordForfeitWin(message.payload.result);
        }
        return;
      }
      case "NETWORK_PAUSE": {
        const message = envelope as RealtimeEnvelope<"NETWORK_PAUSE">;
        const adoptedEpoch = Math.max(this.pauseEpoch, message.payload.pauseEpoch);
        if (!this.advanceSimulationTo(message.payload.proposedPauseTick)) return;
        this.enterNetworkPause(false, adoptedEpoch);
        return;
      }
      case "RESUME_STATE":
        this.applyResumeState(envelope as RealtimeEnvelope<"RESUME_STATE">);
        return;
      case "RESULT_CONFIRM":
        this.receiveResultConfirm(envelope as RealtimeEnvelope<"RESULT_CONFIRM">);
        return;
    }
  }

  private applyMatchConfig(envelope: RealtimeEnvelope<"MATCH_CONFIG">): void {
    if (this.options.seat !== "b") return;
    const config = envelope.payload;
    const expectedHash = competitiveConfigHash(
      config.rulesHash,
      config.seed,
      config.seatAPlayerId,
      config.seatBPlayerId,
    );
    const accepted =
      config.rulesVersion === RULES.rulesVersion &&
      config.rulesHash === this.options.rulesHash &&
      config.coordinatorPlayerId === this.options.peer.senderId &&
      config.seatAPlayerId === this.options.peer.senderId &&
      config.seatBPlayerId === this.options.identity.senderId &&
      config.configHash === expectedHash;
    if (accepted) this.adoptConfig(config);
    else this.setPhase("version-mismatch");
    this.pendingConfigAck = {
      configHash: config.configHash,
      accepted,
      ...(accepted ? {} : { reason: "rules-or-config-mismatch" }),
    };
    this.configAckDeadlineMs = this.options.clock.now() + RULES.network.missingPeerMs;
    if (!accepted || this.clockCommitReceived) this.sendConfigAck();
  }

  private applyRemoteStart(envelope: RealtimeEnvelope<"START">): void {
    if (this.options.seat !== "b") return;
    const { epoch, startTick } = envelope.payload;
    const expectedPhase = epoch === 0 ? "lobby" : "network-pause";
    if (
      this.phase !== expectedPhase ||
      (epoch > 0 && epoch !== this.pauseEpoch) ||
      Math.abs(startTick - this.currentTick()) > MAX_REMOTE_TICK_ADVANCE
    ) {
      this.desynchronize("remote-start-out-of-range");
      return;
    }
    this.applyStart(envelope.payload);
  }

  private sendConfigAck(): void {
    if (this.pendingConfigAck === null) return;
    this.configAckLastSentMs = this.options.clock.now();
    this.sendEnvelope("CONFIG_ACK", this.pendingConfigAck);
  }

  private pumpConfigAck(): void {
    if (
      this.configAckDeadlineMs !== null &&
      this.options.clock.now() >= this.configAckDeadlineMs &&
      ((this.options.seat === "a" && this.phase === "synchronizing") ||
        (this.options.seat === "b" && this.pendingConfigAck !== null))
    ) {
      this.pendingConfigAck = null;
      this.configAckLastSentMs = null;
      this.configAckDeadlineMs = null;
      this.pendingClockCommit = null;
      this.clockCommitLastSentMs = null;
      this.clockCommitDeadlineMs = null;
      if (this.phase === "version-mismatch") return;
      this.desynchronize("config-ack-timeout");
      return;
    }
    if (
      this.options.seat !== "b" ||
      this.pendingConfigAck === null ||
      this.configAckLastSentMs === null ||
      this.options.clock.now() - this.configAckLastSentMs < RULES.network.retryMs
    ) {
      return;
    }
    this.sendConfigAck();
  }

  private sendKeepalive(force: boolean): void {
    if (!this.channelConnected) return;
    const now = this.options.clock.now();
    if (!force && now - this.lastKeepaliveSentMs < RULES.network.keepaliveMs) return;
    this.lastKeepaliveSentMs = now;
    this.sendEnvelope("KEEPALIVE", {
      activeSessionId: this.options.identity.sessionId,
      lastSnapshotSeq: this.snapshotSequence,
      inboundCritical: this.reliability.inboundCursors(),
    });
    if (this.phase === "lobby" || this.phase === "synchronizing") {
      this.sendHello();
      this.sendEnvelope("READY", {
        ready: this.localReady,
        rulesHash: this.options.rulesHash,
      });
    }
  }

  private enterNetworkPause(announce: boolean, adoptedEpoch?: number): void {
    if (this.phase === "finished" || this.phase === "network-pause") return;
    const snapshot = this.simulation?.readSnapshot();
    this.pauseEpoch = adoptedEpoch ?? this.pauseEpoch + 1;
    this.pauseTick = snapshot?.tick ?? this.tickClock.pauseAt(this.options.clock.now());
    this.tickClock.pauseAt(this.options.clock.now());
    this.simulation?.setPaused(true);
    this.missingSinceMs = this.options.clock.now();
    this.localResumeSent = false;
    this.remoteResumeReceived = false;
    this.remoteResumeTick = null;
    this.startScheduled = false;
    this.clockCommitReceived = false;
    this.setPhase("network-pause");
    if (announce && this.channelConnected && this.config !== null) {
      this.reliability.sendCritical(
        "NETWORK_PAUSE",
        {
          eventId: this.nextEventId("network-pause"),
          pauseEpoch: this.pauseEpoch,
          proposedPauseTick: this.pauseTick,
        },
        this.pauseTick,
      );
    }
  }

  private advanceSimulationTo(targetTick: Tick): boolean {
    const simulation = this.simulation;
    if (simulation === null) return false;
    let snapshot = simulation.readSnapshot();
    if (Math.abs(targetTick - snapshot.tick) > MAX_REMOTE_TICK_ADVANCE) {
      this.desynchronize("remote-tick-out-of-range");
      return false;
    }
    if (targetTick < snapshot.tick) {
      const checkpoint = this.simulationCheckpoints.get(targetTick);
      if (checkpoint === undefined) {
        this.desynchronize("remote-tick-checkpoint-missing");
        return false;
      }
      simulation.restore(checkpoint);
      for (const tick of this.simulationCheckpoints.keys()) {
        if (tick > targetTick) this.simulationCheckpoints.delete(tick);
      }
      this.localFinalClaim = null;
      if (this.localTopOutTick !== null && this.localTopOutTick > targetTick) {
        this.localTopOutTick = null;
      }
      this.localResultConfirmation = null;
      this.peerResultConfirmation = null;
      this.confirmedResult = null;
      this.resultSettleAfterMs = null;
      this.snapshotScheduler.reset();
      this.publishSnapshotIfDue(simulation.readSnapshot(), true);
      return true;
    }
    if (this.phase !== "playing") {
      return this.phase === "finished" &&
        this.terminal?.reason === "top-out" &&
        targetTick <= snapshot.tick;
    }
    while (snapshot.tick < targetTick && this.phase === "playing") {
      const effects = simulation.tick(1);
      this.recordSimulationCheckpoint();
      this.publishEffects(effects);
      snapshot = simulation.readSnapshot();
      this.publishSnapshotIfDue(snapshot);
    }
    return true;
  }

  private recordSimulationCheckpoint(): void {
    const checkpoint = this.simulation?.checkpoint();
    if (checkpoint === undefined) return;
    this.simulationCheckpoints.set(checkpoint.tick, checkpoint);
    const oldestRetainedTick = checkpoint.tick - MAX_CHECKPOINT_HISTORY + 1;
    for (const tick of this.simulationCheckpoints.keys()) {
      if (tick < oldestRetainedTick) this.simulationCheckpoints.delete(tick);
    }
  }

  private notePeerReturn(): void {
    this.peerPresent = true;
    if (this.phase !== "network-pause" || this.peerReturnNoted) return;
    this.peerReturnNoted = true;
    this.missingSinceMs = null;
    this.sendKeepalive(true);
    if (this.options.seat === "a") this.beginClockSync("resume");
  }

  private sendResumeState(): void {
    if (this.localResumeSent || this.config === null || this.simulation === null) return;
    const snapshot = this.simulation.readSnapshot();
    this.localResumeSent = true;
    const payload: ResumeStatePayload = {
      eventId: this.nextEventId("resume-state"),
      pauseEpoch: this.pauseEpoch,
      configHash: this.config.configHash,
      snapshot: createPlayerSnapshot({
        player: snapshot.player,
        stateTick: snapshot.tick,
        snapshotSeq: this.snapshotSequence,
        level: snapshot.level,
        ghostRow: snapshot.ghostY,
        nextFive: snapshot.preview,
        lastAppliedCritical: this.reliability.inboundCursors(),
        stateHash: snapshot.stateHash,
      }),
      inboundCritical: this.reliability.inboundCursors(),
    };
    this.reliability.sendCritical("RESUME_STATE", payload, snapshot.tick);
    this.maybeScheduleResume();
  }

  private applyResumeState(envelope: RealtimeEnvelope<"RESUME_STATE">): void {
    if (
      this.phase !== "network-pause" ||
      this.config === null ||
      envelope.payload.configHash !== this.config.configHash ||
      envelope.payload.pauseEpoch !== this.pauseEpoch
    ) {
      return;
    }
    const accepted = this.remoteSnapshots.accept({
      protocol: 1,
      matchId: envelope.matchId,
      senderId: envelope.senderId,
      sessionId: envelope.sessionId,
      kind: "SNAPSHOT",
      matchTick: envelope.payload.snapshot.stateTick,
      sentAtMonotonicMs: envelope.sentAtMonotonicMs,
      payload: envelope.payload.snapshot,
    });
    if (!accepted) {
      const current = this.remoteSnapshots.latest(envelope.senderId);
      if (
        current === undefined ||
        current.snapshotSeq !== envelope.payload.snapshot.snapshotSeq ||
        current.stateTick !== envelope.payload.snapshot.stateTick ||
        current.stateHash !== envelope.payload.snapshot.stateHash
      ) {
        return;
      }
    }
    for (const cursor of envelope.payload.inboundCritical) {
      this.reliability.acknowledgeCursor(cursor);
    }
    this.remoteResumeReceived = true;
    this.remoteResumeTick = envelope.payload.snapshot.stateTick;
    this.maybeScheduleResume();
  }

  private maybeScheduleResume(): void {
    if (
      this.options.seat !== "a" ||
      !this.localResumeSent ||
      !this.remoteResumeReceived ||
      this.startScheduled ||
      this.simulation === null
    ) {
      return;
    }
    const localTick = this.simulation.readSnapshot().tick;
    if (this.remoteResumeTick !== localTick) {
      this.desynchronize("resume-state-tick-mismatch");
      return;
    }
    this.scheduleStart(localTick, this.pauseEpoch);
  }

  private captureLocalFinalClaim(): FinalPlayerClaim | null {
    if (this.localFinalClaim !== null) return this.localFinalClaim;
    const snapshot = this.simulation?.readSnapshot();
    if (snapshot === undefined) return null;
    this.localFinalClaim = {
      stats: statsFromSnapshot(snapshot),
    };
    return this.localFinalClaim;
  }

  private deferResultConsensus(): void {
    const deadline = this.options.clock.now() + RULES.network.retryMs;
    this.resultSettleAfterMs = Math.max(this.resultSettleAfterMs ?? 0, deadline);
    this.resultConsensusDeadlineMs ??=
      this.options.clock.now() + RULES.network.reconnectGraceMs;
  }

  private seatA(): CompetitiveParticipant {
    return this.options.seat === "a" ? this.options.identity : this.options.peer;
  }

  private seatB(): CompetitiveParticipant {
    return this.options.seat === "b" ? this.options.identity : this.options.peer;
  }

  private buildTopOutResult(): MatchResultV1 | null {
    if (
      this.config === null ||
      this.localFinalClaim === null ||
      this.peerFinalClaim === null ||
      (this.localTopOutTick === null && this.peerTopOutTick === null)
    ) {
      return null;
    }
    const seatA = this.seatA();
    const seatB = this.seatB();
    const seatAClaim =
      this.options.seat === "a" ? this.localFinalClaim : this.peerFinalClaim;
    const seatBClaim =
      this.options.seat === "b" ? this.localFinalClaim : this.peerFinalClaim;
    const seatATopOut =
      this.options.seat === "a" ? this.localTopOutTick : this.peerTopOutTick;
    const seatBTopOut =
      this.options.seat === "b" ? this.localTopOutTick : this.peerTopOutTick;
    const terminalTicks = [seatATopOut, seatBTopOut].filter(
      (tick): tick is Tick => tick !== null,
    );
    const durationTicks = Math.min(...terminalTicks);
    const simultaneous =
      seatATopOut !== null &&
      seatBTopOut !== null &&
      seatATopOut === seatBTopOut;
    const outcome: MatchResultV1["outcome"] = simultaneous
      ? "draw"
      : seatATopOut !== null &&
          (seatBTopOut === null || seatATopOut < seatBTopOut)
        ? "seat-b"
        : "seat-a";
    return {
      schema: "split-stack/result/v1",
      matchId: this.options.matchId,
      seedHash: hashCanonicalHex({ seed: this.config.seed }),
      players: [
        { id: seatA.senderId, displayName: seatA.displayName },
        { id: seatB.senderId, displayName: seatB.displayName },
      ],
      outcome,
      reason: simultaneous ? "simultaneous" : "top-out",
      durationTicks,
      finalLevel: Math.floor(durationTicks / RULES.timing.levelTicks) + 1,
      statsByPlayer: {
        [seatA.senderId]: cloneStats(seatAClaim.stats),
        [seatB.senderId]: cloneStats(seatBClaim.stats),
      },
      completedBy: seatA.senderId,
    };
  }

  private receiveResultConfirm(envelope: RealtimeEnvelope<"RESULT_CONFIRM">): void {
    const { result, resultHash } = envelope.payload;
    if (
      resultHash !== hashCanonicalHex(result) ||
      result.matchId !== this.options.matchId ||
      this.localFinalClaim === null ||
      this.terminal?.reason !== "top-out"
    ) {
      return;
    }
    const peerStats = result.statsByPlayer[this.options.peer.senderId];
    if (peerStats === undefined) return;
    if (
      (this.peerTopOutTick === null && peerStats.topOutTick !== undefined) ||
      (this.peerTopOutTick !== null && peerStats.topOutTick !== this.peerTopOutTick)
    ) {
      return;
    }
    const proposedPeerClaim: FinalPlayerClaim = {
      stats: cloneStats(peerStats),
    };
    if (
      this.peerFinalClaim !== null &&
      canonicalize(this.peerFinalClaim.stats) !== canonicalize(proposedPeerClaim.stats)
    ) {
      return;
    }

    const previousPeerClaim = this.peerFinalClaim;
    this.peerFinalClaim = proposedPeerClaim;
    const expected = this.buildTopOutResult();
    if (expected === null || canonicalize(expected) !== canonicalize(result)) {
      this.peerFinalClaim = previousPeerClaim;
      return;
    }
    this.peerResultConfirmation = {
      hash: resultHash,
      result: cloneResult(result),
    };
    this.maybeBeginResultConsensus();
    this.maybeConfirmNormalResult();
  }

  private maybeBeginResultConsensus(): void {
    if (
      this.terminal?.reason !== "top-out" ||
      this.resultSettleAfterMs === null ||
      this.options.clock.now() < this.resultSettleAfterMs
    ) {
      return;
    }
    this.captureLocalFinalClaim();
    const result = this.buildTopOutResult();
    if (result === null) return;
    const hash = hashCanonicalHex(result);
    if (this.localResultConfirmation?.hash !== hash) {
      // Record the local vote before broadcasting. The in-memory transport and
      // Webxdc implementations may synchronously re-enter through the peer.
      this.localResultConfirmation = { hash, result: cloneResult(result) };
      this.reliability.sendCritical(
        "RESULT_CONFIRM",
        {
          eventId: this.nextEventId(`result-confirm:${hash}`),
          resultHash: hash,
          result: cloneResult(result),
        },
        result.durationTicks,
      );
    }
    this.maybeConfirmNormalResult();
  }

  private maybeConfirmNormalResult(): void {
    const local = this.localResultConfirmation;
    const peer = this.peerResultConfirmation;
    if (
      local === null ||
      peer === null ||
      local.hash !== peer.hash ||
      canonicalize(local.result) !== canonicalize(peer.result)
    ) {
      return;
    }
    this.confirmedResult = cloneResult(local.result);
    this.resultConsensusDeadlineMs = null;
    if (this.options.seat !== "a" || this.durableResultEmitted) return;
    this.durableResultEmitted = true;
    this.options.onResultConfirmed?.(cloneResult(local.result));
  }

  private emitForfeitResult(): void {
    if (this.durableResultEmitted || this.config === null) return;
    const localSnapshot = this.simulation?.readSnapshot();
    if (localSnapshot === undefined) return;
    const remoteSnapshot = this.remoteSnapshots.latest(this.options.peer.senderId);
    const localClaim = this.captureLocalFinalClaim();
    if (localClaim === null) return;
    const peerClaim: FinalPlayerClaim = remoteSnapshot === undefined
      ? { stats: emptyResultStats() }
      : {
          stats: statsFromSnapshot(remoteSnapshot),
        };
    const seatA = this.seatA();
    const seatB = this.seatB();
    const seatAClaim = this.options.seat === "a" ? localClaim : peerClaim;
    const seatBClaim = this.options.seat === "b" ? localClaim : peerClaim;
    const durationTicks = Math.max(
      localSnapshot.tick,
      remoteSnapshot?.stateTick ?? 0,
    );
    const result: MatchResultV1 = {
      schema: "split-stack/result/v1",
      matchId: this.options.matchId,
      seedHash: hashCanonicalHex({ seed: this.config.seed }),
      players: [
        { id: seatA.senderId, displayName: seatA.displayName },
        { id: seatB.senderId, displayName: seatB.displayName },
      ],
      outcome: this.options.seat === "a" ? "seat-a" : "seat-b",
      reason: "forfeit",
      durationTicks,
      finalLevel: Math.floor(durationTicks / RULES.timing.levelTicks) + 1,
      statsByPlayer: {
        [seatA.senderId]: cloneStats(seatAClaim.stats),
        [seatB.senderId]: cloneStats(seatBClaim.stats),
      },
      completedBy: this.options.identity.senderId,
    };
    this.confirmedResult = cloneResult(result);
    this.durableResultEmitted = true;
    this.options.onResultConfirmed?.(cloneResult(result));
  }

  private buildExplicitForfeitResult(): MatchResultV1 | null {
    if (this.config === null) return null;
    const localSnapshot = this.simulation?.readSnapshot();
    if (localSnapshot === undefined) return null;
    const remoteSnapshot = this.remoteSnapshots.latest(this.options.peer.senderId);
    const localClaim = this.captureLocalFinalClaim();
    if (localClaim === null) return null;
    const peerClaim: FinalPlayerClaim = remoteSnapshot === undefined
      ? { stats: emptyResultStats() }
      : { stats: statsFromSnapshot(remoteSnapshot) };
    const seatA = this.seatA();
    const seatB = this.seatB();
    const seatAClaim = this.options.seat === "a" ? localClaim : peerClaim;
    const seatBClaim = this.options.seat === "b" ? localClaim : peerClaim;
    const durationTicks = localSnapshot.tick;
    return {
      schema: "split-stack/result/v1",
      matchId: this.options.matchId,
      seedHash: hashCanonicalHex({ seed: this.config.seed }),
      players: [
        { id: seatA.senderId, displayName: seatA.displayName },
        { id: seatB.senderId, displayName: seatB.displayName },
      ],
      outcome: this.options.seat === "a" ? "seat-b" : "seat-a",
      reason: "forfeit",
      durationTicks,
      finalLevel: Math.floor(durationTicks / RULES.timing.levelTicks) + 1,
      statsByPlayer: {
        [seatA.senderId]: cloneStats(seatAClaim.stats),
        [seatB.senderId]: cloneStats(seatBClaim.stats),
      },
      completedBy: this.options.identity.senderId,
    };
  }

  private isValidExplicitForfeit(envelope: RealtimeEnvelope<"FORFEIT">): boolean {
    if (this.config === null) return false;
    const result = envelope.payload.result;
    const seatA = this.seatA();
    const seatB = this.seatB();
    const expectedOutcome = this.options.seat === "a" ? "seat-a" : "seat-b";
    return (
      envelope.payload.resultHash === hashCanonicalHex(result) &&
      result.matchId === this.options.matchId &&
      result.seedHash === hashCanonicalHex({ seed: this.config.seed }) &&
      result.players[0]?.id === seatA.senderId &&
      result.players[0]?.displayName === seatA.displayName &&
      result.players[1]?.id === seatB.senderId &&
      result.players[1]?.displayName === seatB.displayName &&
      result.outcome === expectedOutcome &&
      result.reason === "forfeit" &&
      result.durationTicks === envelope.matchTick &&
      result.finalLevel ===
        Math.floor(result.durationTicks / RULES.timing.levelTicks) + 1 &&
      result.completedBy === envelope.senderId
    );
  }

  private recordForfeitWin(canonicalResult?: MatchResultV1): void {
    if (this.forfeitRecorded || this.terminal !== null) return;
    this.forfeitRecorded = true;
    this.simulation?.setPaused(true);
    this.setTerminal({
      outcome: "local-win",
      reason: "forfeit",
      localTopOutTick: this.localTopOutTick,
      peerTopOutTick: this.peerTopOutTick,
    });
    this.setPhase("finished");
    this.options.onForfeitWin?.(this.options.peer.senderId);
    if (canonicalResult === undefined) {
      this.emitForfeitResult();
    } else if (!this.durableResultEmitted) {
      this.confirmedResult = cloneResult(canonicalResult);
      this.durableResultEmitted = true;
      this.options.onResultConfirmed?.(cloneResult(canonicalResult));
    }
  }

  private finishForTopOut(): void {
    if (
      this.terminal?.reason === "forfeit" ||
      this.terminal?.reason === "desynchronization"
    ) {
      return;
    }
    if (this.localTopOutTick === null && this.peerTopOutTick === null) return;
    const outcome =
      this.localTopOutTick !== null && this.peerTopOutTick !== null
        ? this.localTopOutTick === this.peerTopOutTick
          ? "draw"
          : this.localTopOutTick < this.peerTopOutTick
            ? "peer-win"
            : "local-win"
        : this.localTopOutTick === null
          ? "local-win"
          : "peer-win";
    this.simulation?.setPaused(true);
    this.setTerminal({
      outcome,
      reason: "top-out",
      localTopOutTick: this.localTopOutTick,
      peerTopOutTick: this.peerTopOutTick,
    });
    this.setPhase("finished");
  }

  private setTerminal(terminal: CompetitiveTerminalState): void {
    this.terminal = { ...terminal };
    this.options.onTerminal?.({ ...terminal });
  }
}
