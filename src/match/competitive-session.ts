import { RULES } from "../config/rules";
import { canonicalize, hashCanonicalHex } from "../domain/hashing";
import { cloneMatchResult as cloneResult } from "../domain/results";
import {
  createSimulation,
  type Simulation,
  type SimulationCheckpoint,
  type SimulationDispatchResult,
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
  CLOCK_SYNC_RETRY_BASE_MS,
  CLOCK_SYNC_RETRY_MAX_MS,
  CLOCK_SYNC_SAMPLE_TARGET,
  MatchTickClock,
  selectClockOffset,
  type ClockSample,
  type MonotonicClock,
} from "../network/clock";
import { decodeEnvelope, encodeEnvelope } from "../network/codec";
import type {
  ClockSyncPurpose,
  ClockSyncTimeoutSummary,
  DesynchronizationReason,
  DetachReason,
  NetworkDiagnosticEventInput,
  NetworkDiagnosticIncidentContext,
  NetworkDiagnostics,
  PauseTrigger,
  RemoteTickDiagnosticContext,
  RemoteTickSource,
  SnapshotRejectionReason,
} from "../network/diagnostics";
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
import { NetworkTelemetry } from "../network/telemetry";
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

export type CompetitiveIncomingAttackKind =
  | "garbage"
  | "hollow-cross"
  | "glitch"
  | "oversize"
  | "scramble"
  | "ghost-jam"
  | "blackout";

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
  reason: "top-out" | "forfeit" | "desynchronization" | "connection-lost";
  localTopOutTick: Tick | null;
  peerTopOutTick: Tick | null;
}

export interface CompetitiveSessionOptions {
  matchId: string;
  seat: CompetitiveSeat;
  identity: CompetitiveParticipant;
  peer: CompetitiveParticipant;
  rulesHash: string;
  /** Experiment-only cadence; null disables periodic snapshots. */
  snapshotIntervalTicks?: Tick | null;
  clock: MonotonicClock;
  transport: CompetitiveRealtimeTransport;
  createSeed?: () => string;
  onPhaseChange?: (phase: CompetitivePhase) => void;
  /** Fires once when the initial synchronized countdown is committed. */
  onStartCommitted?: () => void;
  onForfeitWin?: (forfeitingPlayerId: PlayerId) => void;
  onRemoteBlackout?: (ownerPlayerId: PlayerId, eventId: string) => void;
  onIncomingGarbage?: (rows: number, eventId: string) => void;
  onIncomingAttack?: (
    kind: CompetitiveIncomingAttackKind,
    eventId: string,
    value?: number,
  ) => void;
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
  /**
   * Requests that the host replace the realtime channel after sustained silence.
   * Return false when the host could not install a replacement so the failure
   * can be recorded without escaping the pump.
   */
  onTransportRecoveryNeeded?: () => boolean | void;
  diagnostics?: NetworkDiagnostics;
}

export type CompetitiveConnectionStatus =
  | "connected"
  | "unstable"
  | "reconnecting"
  | "resynchronizing"
  | "lost";

export interface CompetitiveSessionView {
  phase: CompetitivePhase;
  localReady: boolean;
  peerReady: boolean;
  peerPresent: boolean;
  peerMissing: boolean;
  connectionStatus: CompetitiveConnectionStatus;
  recoveryRequired: boolean;
  reconnectRemainingSeconds?: number;
  resuming: boolean;
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

export interface CompetitiveSessionViewOptions {
  afterRemoteSnapshotSeq?: number;
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

interface PendingLocalStart {
  proposal: RealtimePayloadMap["START"];
  countdownTicks: number;
  proposalSent: boolean;
  commit: RealtimePayloadMap["START_COMMIT"] | null;
}

interface PendingRemoteStart {
  proposal: RealtimePayloadMap["START"];
}

type GameplayCriticalKind =
  | "GARBAGE_ATTACK"
  | "HOLLOW_CROSS"
  | "GLITCH_PIECE"
  | "OVERSIZE_PIECE"
  | "SCRAMBLE_START"
  | "GHOST_JAM_START"
  | "BLACKOUT_START";

type GameplayCriticalEnvelope = RealtimeEnvelope<GameplayCriticalKind>;

interface GameplayJournalEntry {
  envelope: GameplayCriticalEnvelope;
  appliedAtTick: Tick | null;
  notified: boolean;
  discarded: boolean;
}

interface ClockSyncDiagnosticCounters {
  pingsSent: number;
  pongsReceived: number;
  pongOutcomes: ClockSyncTimeoutSummary["pongOutcomes"];
  lastPongAtMs: number | null;
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
  (RULES.network.maxRollbackMs * RULES.timing.ticksPerSecond) / 1_000,
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
  private locallyHidden = false;
  private started = false;
  private phase: CompetitivePhase = "lobby";
  private localReady = false;
  private peerReady = false;
  private peerPresent = false;
  private peerResumeAvailable = true;
  private simulation: Simulation | null = null;
  private readonly tickClock = new MatchTickClock(RULES.timing.ticksPerSecond);
  private readonly reliability: CriticalReliability;
  private readonly liveness: PeerLiveness;
  private readonly telemetry: NetworkTelemetry;
  private readonly remoteSnapshots = new RemoteSnapshotStore();
  private readonly snapshotScheduler: SnapshotScheduler;
  private snapshotSequence = 0;
  private remoteSnapshotsAccepted = 0;
  private remoteSnapshotsRejected = 0;
  private lastRemoteSnapshotSeq: number | null = null;
  private lastRemoteSnapshotTick: Tick | null = null;
  private lastRemoteSnapshotReceivedMs: number | null = null;
  private lastPeerSnapshotSeq: number | null = null;
  private lastSnapshotRejection: SnapshotRejectionReason | null = null;
  private lastKeepaliveSentMs: number;
  private scheduledStartLocalMs: number | null = null;
  private config: MatchConfigPayload | null = null;
  private clockOffsetMs = 0;
  private selectedClockSampleIds: number[] = [];
  private readonly clockSamples = new Map<number, ClockSample>();
  private readonly pingSentAt = new Map<number, number>();
  private nextClockSampleId = 1;
  private syncPurpose: ClockSyncPurpose | null = null;
  private clockSyncStartedMs: number | null = null;
  private clockSyncLastAttemptMs: number | null = null;
  private clockSyncDeadlineMs: number | null = null;
  private clockSyncRetryAttempt = 0;
  private clockSyncDiagnostic: ClockSyncDiagnosticCounters | null = null;
  private pendingClockCommit: RealtimePayloadMap["CLOCK_COMMIT"] | null = null;
  private clockCommitLastSentMs: number | null = null;
  private clockCommitDeadlineMs: number | null = null;
  private clockCommitReceived = false;
  private pendingConfigAck: RealtimePayloadMap["CONFIG_ACK"] | null = null;
  private configAckLastSentMs: number | null = null;
  private configAckDeadlineMs: number | null = null;
  private startScheduled = false;
  private initialStartCommitted = false;
  private pendingLocalStart: PendingLocalStart | null = null;
  private pendingRemoteStart: PendingRemoteStart | null = null;
  private pauseEpoch = 0;
  private pauseTick: Tick = 0;
  private pauseRequiresOrientation = false;
  private missingSinceMs: number | null = null;
  private localResumeSent = false;
  private remoteResumeReceived = false;
  private remoteResumeTick: Tick | null = null;
  private peerReturnNoted = false;
  private transportRecoveryRequested = false;
  private lastTransportRecoveryRequestMs: number | null = null;
  private connectionLossRecorded = false;
  private connectionIncidentStartedMs: number | null = null;
  private diagnosticIncidentId: number | null = null;
  private recoveryAttempt = 0;
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
  private readonly gameplayJournal: GameplayJournalEntry[] = [];

  public constructor(private readonly options: CompetitiveSessionOptions) {
    if (options.identity.senderId === options.peer.senderId) {
      throw new TypeError("Competitive participants must have distinct player IDs");
    }
    this.transport = options.transport;
    this.snapshotScheduler = new SnapshotScheduler(options.snapshotIntervalTicks);
    this.telemetry = new NetworkTelemetry({ clock: options.clock });
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
    this.telemetry.noteChannelAttached();
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
    return this.dispatchWithResult(action).effects;
  }

  public dispatchWithResult(action: LogicalAction): SimulationDispatchResult {
    if (this.phase !== "playing" || this.simulation === null) {
      return { accepted: false, effects: [] };
    }
    const result = this.simulation.dispatchWithResult(action);
    if (result.accepted) this.recordSimulationCheckpoint();
    this.publishEffects(result.effects);
    return result;
  }

  public isLocalScrambled(): boolean {
    return this.simulation?.hasStatus("scramble") ?? false;
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
    this.telemetry.notePump();
    // Capture the outage before sending anything. In-memory and Webxdc
    // transports can re-enter synchronously: a returning KEEPALIVE may provoke
    // an immediate peer response that refreshes liveness and would otherwise
    // make us fast-forward the entire foreground stall before freezing.
    if (this.phase === "playing" && this.liveness.isMissing()) {
      this.enterNetworkPause(
        true,
        true,
        undefined,
        this.options.clock.now() - this.liveness.silentForMs(),
      );
    }
    this.sendKeepalive(false);
    this.reliability.pump();
    this.telemetry.noteCriticalPending(this.reliability.pendingCount);
    this.maybeCommitLocalStart();
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
      this.publishSnapshotIfDue(undefined, true);
      if (this.pauseEpoch > 0 && this.diagnosticIncidentId !== null) {
        this.recordDiagnostic({
          kind: "resumed",
          pauseTick: this.currentTick(),
          pauseEpoch: this.pauseEpoch,
        });
        this.diagnosticIncidentId = null;
      }
    }

    if (this.phase === "playing") {
      this.advanceSimulation();
    }

    if (
      this.phase === "network-pause" &&
      ((this.lastTransportRecoveryRequestMs === null &&
        this.liveness.silentForMs() >= this.transportRecoveryThresholdMs()) ||
        (this.lastTransportRecoveryRequestMs !== null &&
          this.options.clock.now() - this.lastTransportRecoveryRequestMs >=
            this.transportRecoveryRetryMs()))
    ) {
      this.requestTransportRecovery();
    }

    if (
      this.phase === "network-pause" &&
      !this.locallyHidden &&
      this.channelConnected &&
      this.connectionIncidentStartedMs !== null &&
      this.options.clock.now() - this.connectionIncidentStartedMs >=
        RULES.network.controllerReconnectGraceMs
    ) {
      this.recordConnectionLost();
    }
  }

  public disconnect(detachReason: DetachReason = "unknown"): void {
    if (!this.channelConnected) return;
    this.channelConnected = false;
    this.reliability.setConnected(false);
    this.telemetry.noteChannelDetached();
    const event: NetworkDiagnosticEventInput = {
      kind: "channel-detached",
      detachReason,
      ...(this.pauseEpoch === 0 ? {} : { pauseEpoch: this.pauseEpoch }),
      telemetry: this.telemetry.snapshot(),
    };
    if (this.diagnosticIncidentId === null && detachReason === "startup-failure") {
      this.options.diagnostics?.begin(event, this.diagnosticContext());
    } else {
      this.recordDiagnostic(event);
    }
    this.transport.leave();
  }

  public attachTransport(transport: CompetitiveRealtimeTransport): void {
    if (this.channelConnected) throw new Error("Realtime transport is already connected");
    this.transport = transport;
    try {
      this.installListener();
    } catch (error) {
      try {
        transport.leave();
      } catch {
        // Preserve the listener-install failure that rejected this transport.
      }
      throw error;
    }
    this.channelConnected = true;
    this.reliability.setConnected(true);
    this.telemetry.noteChannelAttached();
    this.recordDiagnostic({
      kind: "channel-attached",
      ...(this.pauseEpoch === 0 ? {} : { pauseEpoch: this.pauseEpoch }),
    });
    this.sendHello();
    this.sendKeepalive(true);
  }

  public noteTransportRecoveryFailure(attempt?: number): void {
    this.recordDiagnostic({
      kind: "channel-replacement-failed",
      silenceMs: Math.floor(this.liveness.silentForMs()),
      ...(this.pauseEpoch === 0 ? {} : { pauseEpoch: this.pauseEpoch }),
      ...(attempt === undefined ? {} : { attempt }),
    });
  }

  public setHidden(hidden: boolean): void {
    const wasHidden = this.locallyHidden;
    this.locallyHidden = hidden;
    if (hidden) {
      if (wasHidden) return;
      this.connectionIncidentStartedMs = null;
      this.enterNetworkPause(true, false);
    } else if (this.phase === "network-pause") {
      if (this.config === null && this.simulation === null) {
        this.pauseEpoch = 0;
        this.pauseTick = 0;
        this.missingSinceMs = null;
        this.peerReturnNoted = false;
        this.setPhase("lobby");
      }
      if (wasHidden && this.phase === "network-pause") {
        this.connectionIncidentStartedMs = this.options.clock.now();
      }
      if (!this.liveness.isMissing() && this.peerResumeAvailable) {
        this.notePeerReturn();
      }
      this.sendKeepalive(true);
    }
  }

  public view(options: CompetitiveSessionViewOptions = {}): CompetitiveSessionView {
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
    const remote = this.remoteSnapshots.latestAfter(
      this.options.peer.senderId,
      options.afterRemoteSnapshotSeq,
    );
    const recoveryRequired =
      this.phase === "network-pause" &&
      (this.transportRecoveryRequested ||
        this.liveness.silentForMs() >= this.transportRecoveryThresholdMs());
    const peerUnstable = this.liveness.isUnstable();
    const reconnectRemainingSeconds =
      this.phase === "network-pause" &&
      !this.locallyHidden &&
      this.channelConnected &&
      this.connectionIncidentStartedMs !== null
        ? Math.max(
            1,
            Math.ceil(
              (RULES.network.controllerReconnectGraceMs -
                Math.max(
                  0,
                  this.options.clock.now() - this.connectionIncidentStartedMs,
                )) /
                1_000,
            ),
          )
        : undefined;
    const connectionStatus: CompetitiveConnectionStatus =
      this.terminal?.reason === "connection-lost"
        ? "lost"
        : this.phase === "network-pause"
          ? this.peerReturnNoted
            ? "resynchronizing"
            : recoveryRequired
              ? "reconnecting"
              : "unstable"
          : peerUnstable
            ? "unstable"
            : "connected";
    const base = {
      phase: this.phase,
      localReady: this.localReady,
      peerReady: this.peerReady,
      peerPresent: this.peerPresent,
      peerMissing: this.phase === "network-pause" || this.liveness.isMissing(),
      connectionStatus,
      recoveryRequired,
      ...(reconnectRemainingSeconds === undefined
        ? {}
        : { reconnectRemainingSeconds }),
      resuming: this.phase === "countdown" && this.pauseEpoch > 0,
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

  private clearPendingStartLifecycle(): void {
    this.pendingLocalStart = null;
    this.pendingRemoteStart = null;
    this.startScheduled = false;
    this.scheduledStartLocalMs = null;
  }

  private desynchronize(
    reason: DesynchronizationReason,
    remoteTick?: RemoteTickDiagnosticContext,
  ): void {
    if (this.phase === "desynchronized") return;
    this.clearPendingStartLifecycle();
    this.clearClockSyncLifecycle();
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
    this.recordDesynchronization(reason, remoteTick);
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
    return this.simulation?.currentTick() ?? 0;
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
      resumeAvailable: !this.locallyHidden,
    });
  }

  private sendEncoded(envelope: RealtimeEnvelope): void {
    if (!this.channelConnected) return;
    const encoded = encodeEnvelope(envelope);
    // Stage before crossing the synchronous transport boundary: an in-memory
    // or Webxdc host may deliver a peer response reentrantly and reset the
    // since-authenticated telemetry window before send() returns.
    this.telemetry.noteSent(encoded.byteLength, envelope.kind);
    try {
      this.transport.send(encoded);
    } catch (error) {
      this.telemetry.noteSendFailed(encoded.byteLength, envelope.kind);
      throw error;
    }
    this.noteSuccessfulStartSend(envelope);
    this.telemetry.noteCriticalPending(this.reliability.pendingCount);
  }

  private noteSuccessfulStartSend(envelope: RealtimeEnvelope): void {
    const pending = this.pendingLocalStart;
    if (pending === null) return;
    if (
      envelope.kind === "START" &&
      envelope.payload.eventId === pending.proposal.eventId
    ) {
      pending.proposalSent = true;
      return;
    }
    if (
      envelope.kind === "START_COMMIT" &&
      pending.commit !== null &&
      envelope.payload.eventId === pending.commit.eventId
    ) {
      // Crossing the transport boundary without throwing is the coordinator's
      // local commit point. The peer may have ACKed reentrantly already.
      this.applyStart(pending.commit);
    }
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
    this.telemetry.noteRawReceived(data.byteLength);
    const decoded = decodeEnvelope(data, {
      expectedMatchId: this.options.matchId,
      allowedSenderIds: this.allowedSenders,
    });
    if (!decoded.ok) return;
    this.telemetry.noteDecodedReceived(data.byteLength);
    if (decoded.value.sessionId !== this.options.peer.sessionId) {
      if (decoded.value.kind === "SNAPSHOT") {
        this.noteSnapshotRejected("session-mismatch");
      }
      return;
    }
    const envelope = decoded.value;

    const peerTrafficObserved = this.liveness.observe(envelope);
    if (peerTrafficObserved) {
      this.telemetry.noteAuthenticatedReceived(data.byteLength);
    }
    if (peerTrafficObserved) this.peerPresent = true;
    if (envelope.kind === "KEEPALIVE" && peerTrafficObserved) {
      const keepalive = envelope as RealtimeEnvelope<"KEEPALIVE">;
      this.peerResumeAvailable = keepalive.payload.resumeAvailable;
      this.lastPeerSnapshotSeq = Math.max(
        this.lastPeerSnapshotSeq ?? 0,
        keepalive.payload.lastSnapshotSeq,
      );
      for (const cursor of keepalive.payload.inboundCritical) {
        this.reliability.acknowledgeCursor(cursor);
      }
      if (this.peerResumeAvailable) this.notePeerReturn();
    } else if (
      peerTrafficObserved &&
      envelope.kind !== "HELLO" &&
      envelope.kind !== "NETWORK_PAUSE" &&
      this.peerResumeAvailable
    ) {
      // Once a peer has explicitly advertised that it is resume-capable, any
      // authenticated traffic proves the replacement channel is usable. This
      // prevents ACK/SNAPSHOT traffic from keeping liveness healthy while a
      // paused match waits forever for a particular KEEPALIVE frame.
      this.notePeerReturn();
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
        this.acceptRemoteSnapshot(envelope as RealtimeEnvelope<"SNAPSHOT">);
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
    this.peerResumeAvailable = envelope.payload.resumeAvailable;
    this.peerPresent = true;
    if (this.peerResumeAvailable) this.notePeerReturn();
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

  private acceptRemoteSnapshot(envelope: RealtimeEnvelope<"SNAPSHOT">): boolean {
    const result = this.remoteSnapshots.acceptDetailed(envelope);
    if (!result.accepted) {
      this.noteSnapshotRejected(result.reason);
      return false;
    }
    this.remoteSnapshotsAccepted += 1;
    this.telemetry.noteSnapshotAccepted(envelope.payload.snapshotSeq);
    this.lastRemoteSnapshotSeq = envelope.payload.snapshotSeq;
    this.lastRemoteSnapshotTick = envelope.payload.stateTick;
    this.lastRemoteSnapshotReceivedMs = this.options.clock.now();
    return true;
  }

  private noteSnapshotRejected(reason: SnapshotRejectionReason): void {
    this.remoteSnapshotsRejected += 1;
    this.lastSnapshotRejection = reason;
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

  private beginClockSync(purpose: ClockSyncPurpose): void {
    if (this.options.seat !== "a" || this.syncPurpose !== null) return;
    const now = this.options.clock.now();
    this.syncPurpose = purpose;
    this.clockSyncStartedMs = now;
    this.clockSyncDeadlineMs = now + RULES.network.missingPeerMs;
    this.clockSamples.clear();
    this.pingSentAt.clear();
    this.clockSyncRetryAttempt = 0;
    this.clockSyncDiagnostic = {
      pingsSent: 0,
      pongsReceived: 0,
      pongOutcomes: {
        accepted: 0,
        unknownSample: 0,
        staleEcho: 0,
        duplicate: 0,
        invalidTiming: 0,
      },
      lastPongAtMs: null,
    };
    if (purpose === "initial") this.setPhase("synchronizing");
    const pings: RealtimePayloadMap["CLOCK_PING"][] = [];
    for (let index = 0; index < CLOCK_SYNC_SAMPLE_TARGET; index += 1) {
      const sampleId = this.nextClockSampleId;
      this.nextClockSampleId += 1;
      const coordinatorSentMs = now;
      this.pingSentAt.set(sampleId, coordinatorSentMs);
      pings.push({ sampleId, coordinatorSentMs });
    }
    // Stage the complete retry set and timer before any transport call. If one
    // send throws after peerReturnNoted was latched, pumpClockSync can still
    // retry all unanswered samples instead of waiting forever.
    this.clockSyncLastAttemptMs = now;
    for (const ping of pings) this.sendClockPing(ping);
  }

  private pumpClockSync(): void {
    if (
      this.options.seat === "a" &&
      this.syncPurpose !== null &&
      this.clockSyncDeadlineMs !== null &&
      this.options.clock.now() >= this.clockSyncDeadlineMs
    ) {
      if (this.syncPurpose === "resume" && this.phase === "network-pause") {
        this.recordClockSyncTimeout();
        this.restartResumeHandshake();
      } else if (this.syncPurpose === "initial" && this.phase === "synchronizing") {
        this.recordClockSyncTimeout();
        this.returnToReadinessAfterInitialSyncTimeout();
      } else {
        this.recordClockSyncTimeout();
        this.clockSyncLastAttemptMs = null;
        this.clockSyncDeadlineMs = null;
        this.desynchronize("clock-sync-timeout");
      }
      return;
    }
    if (this.maybeFinishClockSync()) return;
    if (
      this.options.seat !== "a" ||
      this.syncPurpose === null ||
      this.clockSyncLastAttemptMs === null ||
      this.options.clock.now() - this.clockSyncLastAttemptMs <
        this.clockSyncRetryDelayMs()
    ) {
      return;
    }
    this.clockSyncLastAttemptMs = this.options.clock.now();
    this.clockSyncRetryAttempt += 1;
    const missingSamples = CLOCK_SYNC_SAMPLE_TARGET - this.clockSamples.size;
    for (let index = 0; index < missingSamples; index += 1) {
      const sampleId = this.nextClockSampleId;
      this.nextClockSampleId += 1;
      const coordinatorSentMs = this.options.clock.now();
      this.pingSentAt.set(sampleId, coordinatorSentMs);
      this.sendClockPing({ sampleId, coordinatorSentMs });
    }
  }

  private sendClockPing(ping: RealtimePayloadMap["CLOCK_PING"]): void {
    const diagnostic = this.clockSyncDiagnostic;
    if (diagnostic !== null) diagnostic.pingsSent += 1;
    try {
      this.sendEnvelope("CLOCK_PING", ping);
    } catch (error) {
      if (diagnostic !== null) diagnostic.pingsSent -= 1;
      throw error;
    }
  }

  private clockSyncRetryDelayMs(): number {
    return Math.min(
      CLOCK_SYNC_RETRY_BASE_MS * 2 ** this.clockSyncRetryAttempt,
      CLOCK_SYNC_RETRY_MAX_MS,
    );
  }

  private clearClockSyncLifecycle(): void {
    this.syncPurpose = null;
    this.clockSyncStartedMs = null;
    this.clockSyncLastAttemptMs = null;
    this.clockSyncDeadlineMs = null;
    this.clockSamples.clear();
    this.pingSentAt.clear();
    this.clockSyncRetryAttempt = 0;
    this.clockSyncDiagnostic = null;
  }

  private returnToReadinessAfterInitialSyncTimeout(): void {
    this.clearClockSyncLifecycle();
    this.localReady = false;
    this.setPhase("lobby");
    this.sendEnvelope("READY", {
      ready: false,
      rulesHash: this.options.rulesHash,
    });
  }

  private recordClockSyncTimeout(): void {
    const diagnostics = this.options.diagnostics;
    const counters = this.clockSyncDiagnostic;
    const purpose = this.syncPurpose;
    const startedAtMs = this.clockSyncStartedMs;
    const deadlineAtMs = this.clockSyncDeadlineMs;
    if (
      diagnostics === undefined ||
      counters === null ||
      purpose === null ||
      startedAtMs === null ||
      deadlineAtMs === null
    ) return;
    const now = this.options.clock.now();
    const clockSync: ClockSyncTimeoutSummary = {
      purpose,
      targetSamples: CLOCK_SYNC_SAMPLE_TARGET,
      acceptedSamples: counters.pongOutcomes.accepted,
      retryRounds: this.clockSyncRetryAttempt,
      pingsSent: counters.pingsSent,
      pongsReceived: counters.pongsReceived,
      pongOutcomes: { ...counters.pongOutcomes },
      elapsedMs: Math.floor(Math.max(0, now - startedAtMs)),
      deadlineMs: Math.floor(Math.max(0, deadlineAtMs - startedAtMs)),
      ...(counters.lastPongAtMs === null
        ? {}
        : {
            lastPongAgeMs: Math.floor(
              Math.max(0, now - counters.lastPongAtMs),
            ),
          }),
    };
    const event: NetworkDiagnosticEventInput = {
      kind: "clock-sync-timeout",
      clockSync,
      ...(purpose === "resume" ? { pauseEpoch: this.pauseEpoch } : {}),
      telemetry: this.telemetry.snapshot(),
    };
    if (purpose === "initial") {
      diagnostics.begin(event, this.diagnosticContext());
    } else if (this.diagnosticIncidentId === null) {
      this.diagnosticIncidentId = diagnostics.begin(
        event,
        this.diagnosticContext(),
      );
    } else {
      diagnostics.record(this.diagnosticIncidentId, event);
    }
  }

  private receiveClockPing(envelope: RealtimeEnvelope<"CLOCK_PING">): void {
    if (this.options.seat !== "b" || this.locallyHidden) return;
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
    const now = this.options.clock.now();
    const diagnostic = this.clockSyncDiagnostic;
    if (diagnostic !== null) {
      diagnostic.pongsReceived += 1;
      diagnostic.lastPongAtMs = now;
    }
    const sentAt = this.pingSentAt.get(envelope.payload.sampleId);
    if (sentAt === undefined) {
      if (diagnostic !== null) diagnostic.pongOutcomes.unknownSample += 1;
      return;
    }
    if (sentAt !== envelope.payload.coordinatorSentMs) {
      if (diagnostic !== null) diagnostic.pongOutcomes.staleEcho += 1;
      return;
    }
    if (this.clockSamples.has(envelope.payload.sampleId)) {
      if (diagnostic !== null) diagnostic.pongOutcomes.duplicate += 1;
      return;
    }
    let sample: ClockSample;
    try {
      sample = calculateClockSample(
        sentAt,
        envelope.payload.peerReceivedMs,
        envelope.payload.peerSentMs,
        now,
        envelope.payload.sampleId,
      );
    } catch {
      if (diagnostic !== null) diagnostic.pongOutcomes.invalidTiming += 1;
      return;
    }
    if (diagnostic !== null) diagnostic.pongOutcomes.accepted += 1;
    this.clockSamples.set(sample.sampleId, sample);
    this.maybeFinishClockSync();
  }

  private maybeFinishClockSync(): boolean {
    if (
      this.clockSamples.size !== CLOCK_SYNC_SAMPLE_TARGET ||
      this.syncPurpose === null
    ) return false;
    if (this.syncPurpose === "resume") {
      const startedAtMs = this.clockSyncStartedMs;
      const now = this.options.clock.now();
      if (
        startedAtMs === null ||
        now - startedAtMs < RULES.network.recoveryStabilityMs ||
        now - this.liveness.silentForMs() <
          startedAtMs + RULES.network.recoveryStabilityMs
      ) {
        return false;
      }
    }
    this.finishClockSync();
    return true;
  }

  private finishClockSync(): void {
    const purpose = this.syncPurpose;
    if (purpose === null) return;
    const selected = selectClockOffset([...this.clockSamples.values()]);
    this.clockOffsetMs = 0;
    this.selectedClockSampleIds = [...selected.selectedSampleIds];
    this.clearClockSyncLifecycle();
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
      if (this.phase === "network-pause") {
        this.restartResumeHandshake();
        return;
      }
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
    if (this.options.seat !== "b" || this.locallyHidden) return;
    this.clockOffsetMs = envelope.payload.offsetPeerMinusCoordinatorMs;
    this.selectedClockSampleIds = [...envelope.payload.sampleIds];
    this.clockCommitReceived = true;
    if (this.phase === "network-pause" && this.config !== null) {
      this.sendEnvelope("CONFIG_ACK", {
        configHash: this.config.configHash,
        accepted: true,
      });
      this.sendResumeState();
    } else {
      this.sendConfigAck();
    }
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
      rulesVersion: RULES.rulesVersion,
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
    this.gameplayJournal.length = 0;
    this.recordSimulationCheckpoint();
  }

  private receiveConfigAck(envelope: RealtimeEnvelope<"CONFIG_ACK">): void {
    if (
      this.options.seat === "a" &&
      this.phase === "network-pause" &&
      this.config !== null &&
      envelope.payload.accepted &&
      envelope.payload.configHash === this.config.configHash
    ) {
      this.pendingClockCommit = null;
      this.clockCommitLastSentMs = null;
      this.clockCommitDeadlineMs = null;
      return;
    }
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

  private scheduleStart(
    startTick: Tick,
    epoch: number,
    countdownTicks: Tick = RULES.network.initialStartCountdownTicks,
  ): void {
    if (this.config === null || this.startScheduled) return;
    this.startScheduled = true;
    const payload: RealtimePayloadMap["START"] = {
      eventId: this.nextEventId(epoch === 0 ? "start" : "resume-start"),
      epoch,
      startAtCoordinatorMs:
        this.options.clock.now() +
        (countdownTicks * 1_000) / RULES.timing.ticksPerSecond,
      startTick,
      configHash: this.config.configHash,
    };
    // Install the proposal before the transport can synchronously deliver it,
    // re-enter through its ACK, or throw. Retries must reuse this semantic ID.
    this.pendingLocalStart = {
      proposal: payload,
      countdownTicks,
      proposalSent: false,
      commit: null,
    };
    this.reliability.sendCritical("START", payload, startTick);
    this.maybeCommitLocalStart();
  }

  private maybeCommitLocalStart(): void {
    const pending = this.pendingLocalStart;
    if (pending === null) return;
    if (pending.commit !== null) {
      // A send that failed before CriticalReliability could queue the commit is
      // retried here with the same ID. A transport failure after queueing is
      // retried by the reliable outbox instead.
      if (!this.reliability.isEventPending(pending.commit.eventId)) {
        this.reliability.sendCritical(
          "START_COMMIT",
          pending.commit,
          pending.commit.startTick,
        );
      }
      return;
    }
    if (!pending.proposalSent) {
      if (!this.reliability.isEventPending(pending.proposal.eventId)) {
        this.reliability.sendCritical(
          "START",
          pending.proposal,
          pending.proposal.startTick,
        );
      }
      return;
    }
    if (this.reliability.isEventPending(pending.proposal.eventId)) {
      return;
    }

    const commit: RealtimePayloadMap["START_COMMIT"] = {
      eventId: this.nextEventId(
        pending.proposal.epoch === 0 ? "start-commit" : "resume-start-commit",
      ),
      proposalEventId: pending.proposal.eventId,
      epoch: pending.proposal.epoch,
      startAtCoordinatorMs:
        this.options.clock.now() +
        (pending.countdownTicks * 1_000) / RULES.timing.ticksPerSecond,
      startTick: pending.proposal.startTick,
      configHash: pending.proposal.configHash,
    };
    // As with the prepare, stage the commit before a reentrant or throwing
    // transport call. The queued reliable envelope then owns all retries.
    pending.commit = commit;
    this.reliability.sendCritical("START_COMMIT", commit, commit.startTick);
  }

  private applyStart(
    payload:
      | RealtimePayloadMap["START"]
      | RealtimePayloadMap["START_COMMIT"],
  ): void {
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
    this.connectionIncidentStartedMs = null;
    this.startScheduled = false;
    this.pendingLocalStart = null;
    this.pendingRemoteStart = null;
    this.localResumeSent = false;
    this.remoteResumeReceived = false;
    this.remoteResumeTick = null;
    this.peerReturnNoted = false;
    this.peerResumeAvailable = true;
    this.pauseRequiresOrientation = false;
    this.transportRecoveryRequested = false;
    this.lastTransportRecoveryRequestMs = null;
    this.pendingClockCommit = null;
    this.clockCommitLastSentMs = null;
    this.clockCommitDeadlineMs = null;
    this.pendingConfigAck = null;
    this.configAckLastSentMs = null;
    this.configAckDeadlineMs = null;
    this.snapshotScheduler.reset();
    if (payload.epoch === 0 && !this.initialStartCommitted) {
      this.initialStartCommitted = true;
      this.options.onStartCommitted?.();
    }
    this.setPhase("countdown");
  }

  private advanceSimulation(): void {
    const simulation = this.simulation;
    if (simulation === null) return;
    const targetTick = this.tickClock.tickAt(this.options.clock.now());
    let snapshotDue = false;
    while (simulation.currentTick() < targetTick && this.phase === "playing") {
      const effects = simulation.tick(1);
      this.recordSimulationCheckpoint();
      this.publishEffects(effects);
      this.flushPendingGameplayCriticals();
      if (effects.length > 0) this.options.onSimulationEffects?.(effects);
      if (
        this.phase === "playing" &&
        this.snapshotScheduler.claim(simulation.currentTick(), true)
      ) {
        snapshotDue = true;
      }
    }
    if (snapshotDue && this.phase === "playing") {
      this.publishSnapshot(simulation.readSnapshot());
    }
  }

  private publishSnapshotIfDue(
    snapshot?: SimulationSnapshot,
    force = false,
  ): void {
    const simulation = this.simulation;
    const tick = snapshot?.tick ?? simulation?.currentTick();
    if (
      tick === undefined ||
      (!force && !this.snapshotScheduler.claim(tick, true))
    ) {
      return;
    }
    const dueSnapshot = snapshot ?? simulation?.readSnapshot();
    if (dueSnapshot !== undefined) this.publishSnapshot(dueSnapshot);
  }

  private publishSnapshot(snapshot: SimulationSnapshot): void {
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
    if (effects.length === 0) return;
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
      } else if (effect.kind === "oversize-piece") {
        this.reliability.sendCritical(
          "OVERSIZE_PIECE",
          { eventId, targetPlayerId: this.options.peer.senderId },
          tick,
        );
      } else if (effect.kind === "scramble-start") {
        this.reliability.sendCritical(
          "SCRAMBLE_START",
          { eventId, targetPlayerId: this.options.peer.senderId },
          tick,
        );
      } else if (effect.kind === "ghost-jam-start") {
        this.reliability.sendCritical(
          "GHOST_JAM_START",
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

  private receiveGameplayCritical(envelope: GameplayCriticalEnvelope): void {
    if (
      envelope.kind !== "BLACKOUT_START" &&
      envelope.payload.targetPlayerId !== this.options.identity.senderId
    ) {
      return;
    }
    if (this.gameplayJournal.length >= RULES.network.maxPendingCritical) {
      this.desynchronize("gameplay-journal-overflow");
      return;
    }
    const entry: GameplayJournalEntry = {
      envelope,
      appliedAtTick: null,
      notified: false,
      discarded: false,
    };
    this.gameplayJournal.push(entry);
    if (
      this.phase === "network-pause" ||
      envelope.matchTick > this.currentTick()
    ) {
      return;
    }
    if (this.applyGameplayJournalEntry(entry)) this.recordSimulationCheckpoint();
  }

  private applyGameplayJournalEntry(entry: GameplayJournalEntry): boolean {
    if (entry.appliedAtTick !== null || entry.discarded) return false;
    const notify = !entry.notified;
    let simulationChanged = false;
    switch (entry.envelope.kind) {
      case "GARBAGE_ATTACK": {
        const message = entry.envelope as RealtimeEnvelope<"GARBAGE_ATTACK">;
        if (notify) {
          this.options.onIncomingAttack?.(
            "garbage",
            message.payload.eventId,
            message.payload.rows,
          );
          this.options.onIncomingGarbage?.(
            message.payload.rows,
            message.payload.eventId,
          );
        }
        this.simulation?.receiveGarbage(
          message.payload.rows,
          message.payload.eventId,
          message.senderId,
          message.matchTick,
        );
        simulationChanged = this.simulation !== null;
        break;
      }
      case "HOLLOW_CROSS": {
        const message = entry.envelope as RealtimeEnvelope<"HOLLOW_CROSS">;
        if (notify) {
          this.options.onIncomingAttack?.("hollow-cross", message.payload.eventId);
        }
        this.simulation?.receiveHollowCross(message.payload.eventId);
        simulationChanged = this.simulation !== null;
        break;
      }
      case "GLITCH_PIECE": {
        const message = entry.envelope as RealtimeEnvelope<"GLITCH_PIECE">;
        if (notify) this.options.onIncomingAttack?.("glitch", message.payload.eventId);
        this.simulation?.receiveGlitch(message.payload.eventId);
        simulationChanged = this.simulation !== null;
        break;
      }
      case "OVERSIZE_PIECE": {
        const message = entry.envelope as RealtimeEnvelope<"OVERSIZE_PIECE">;
        const effects = this.simulation?.receiveOversize(
          message.payload.eventId,
          message.senderId,
          message.matchTick,
        ) ?? [];
        const overflow = effects.find((effect) => effect.kind === "oversize-overflow");
        if (notify) {
          if (overflow !== undefined) {
            const rows = overflow.rows ?? RULES.power.oversizeOverflowGarbageRows;
            const overflowEventId = `${message.payload.eventId}:overflow`;
            this.options.onIncomingAttack?.("garbage", overflowEventId, rows);
            this.options.onIncomingGarbage?.(rows, overflowEventId);
          } else {
            this.options.onIncomingAttack?.("oversize", message.payload.eventId);
          }
        }
        simulationChanged = this.simulation !== null;
        break;
      }
      case "SCRAMBLE_START": {
        const message = entry.envelope as RealtimeEnvelope<"SCRAMBLE_START">;
        if (notify) this.options.onIncomingAttack?.("scramble", message.payload.eventId);
        this.simulation?.receiveScramble();
        simulationChanged = this.simulation !== null;
        break;
      }
      case "GHOST_JAM_START": {
        const message = entry.envelope as RealtimeEnvelope<"GHOST_JAM_START">;
        if (notify) this.options.onIncomingAttack?.("ghost-jam", message.payload.eventId);
        this.simulation?.receiveGhostJam();
        simulationChanged = this.simulation !== null;
        break;
      }
      case "BLACKOUT_START": {
        const message = entry.envelope as RealtimeEnvelope<"BLACKOUT_START">;
        if (notify) {
          this.options.onIncomingAttack?.("blackout", message.payload.eventId);
          this.options.onRemoteBlackout?.(
            message.payload.ownerPlayerId,
            message.payload.eventId,
          );
        }
        break;
      }
    }
    entry.notified = true;
    entry.appliedAtTick = this.currentTick();
    return simulationChanged;
  }

  private flushPendingGameplayCriticals(canonicalTick?: Tick): boolean {
    let applied = false;
    let simulationChanged = false;
    for (const entry of this.gameplayJournal) {
      if (
        canonicalTick !== undefined &&
        entry.envelope.matchTick > canonicalTick
      ) {
        if (entry.appliedAtTick !== null && !entry.discarded) {
          this.desynchronize("future-gameplay-critical-applied");
          return false;
        }
        entry.discarded = true;
        entry.appliedAtTick = canonicalTick;
        continue;
      }
      if (entry.appliedAtTick !== null) continue;
      if (
        canonicalTick === undefined &&
        entry.envelope.matchTick > this.currentTick()
      ) {
        continue;
      }
      applied = true;
      simulationChanged = this.applyGameplayJournalEntry(entry) || simulationChanged;
    }
    if (!applied) return false;
    if (simulationChanged) this.recordSimulationCheckpoint();
    return true;
  }

  private rewindGameplayJournal(targetTick: Tick): void {
    for (const entry of this.gameplayJournal) {
      if (
        !entry.discarded &&
        entry.appliedAtTick !== null &&
        entry.appliedAtTick > targetTick
      ) {
        entry.appliedAtTick = null;
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
      case "START_COMMIT":
        this.applyRemoteStartCommit(
          envelope as RealtimeEnvelope<"START_COMMIT">,
        );
        return;
      case "GARBAGE_ATTACK":
      case "HOLLOW_CROSS":
      case "GLITCH_PIECE":
      case "OVERSIZE_PIECE":
      case "SCRAMBLE_START":
      case "GHOST_JAM_START":
      case "BLACKOUT_START": {
        this.receiveGameplayCritical(envelope as GameplayCriticalEnvelope);
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
        if (!this.advanceSimulationTo(message.matchTick, false, "top-out")) return;
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
        this.peerResumeAvailable = false;
        const adoptedEpoch = Math.max(this.pauseEpoch, message.payload.pauseEpoch);
        if (
          !this.advanceSimulationTo(
            message.payload.proposedPauseTick,
            true,
            "network-pause",
          )
        ) return;
        this.enterNetworkPause(
          false,
          message.payload.connectionIssue,
          adoptedEpoch,
        );
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
    const { epoch, startTick, configHash } = envelope.payload;
    const expectedPhase = epoch === 0 ? "lobby" : "network-pause";
    if (
      this.terminal !== null ||
      this.config === null ||
      configHash !== this.config.configHash ||
      this.phase !== expectedPhase ||
      (epoch > 0 && epoch !== this.pauseEpoch)
    ) {
      // A prepare from an older lifecycle is harmless. It must not revive or
      // desynchronize a newer pause/countdown/terminal state.
      return;
    }
    if (
      Math.abs(startTick - this.currentTick()) > MAX_REMOTE_TICK_ADVANCE
    ) {
      this.desynchronize("remote-start-out-of-range");
      return;
    }
    if (this.pendingRemoteStart !== null) {
      // Keep the first bounded proposal for an epoch. A coordinator retry uses
      // the same reliable event; distinct proposals cannot move the target.
      return;
    }
    this.pendingRemoteStart = { proposal: { ...envelope.payload } };
  }

  private applyRemoteStartCommit(
    envelope: RealtimeEnvelope<"START_COMMIT">,
  ): void {
    if (this.options.seat !== "b") return;
    const pending = this.pendingRemoteStart;
    const commit = envelope.payload;
    if (
      pending === null ||
      this.terminal !== null ||
      this.config === null ||
      commit.proposalEventId !== pending.proposal.eventId ||
      commit.epoch !== pending.proposal.epoch ||
      commit.startTick !== pending.proposal.startTick ||
      commit.configHash !== pending.proposal.configHash ||
      commit.configHash !== this.config.configHash
    ) {
      return;
    }
    const expectedPhase = commit.epoch === 0 ? "lobby" : "network-pause";
    if (
      this.phase !== expectedPhase ||
      (commit.epoch > 0 && commit.epoch !== this.pauseEpoch)
    ) {
      return;
    }
    if (
      Math.abs(commit.startTick - this.currentTick()) > MAX_REMOTE_TICK_ADVANCE
    ) {
      this.desynchronize("remote-start-out-of-range");
      return;
    }
    if (commit.epoch > 0) {
      if (
        !this.advanceSimulationTo(
          commit.startTick,
          true,
          "resume-start-commit",
        )
      ) return;
      this.flushPendingGameplayCriticals(commit.startTick);
      this.snapshotScheduler.reset();
      this.publishSnapshotIfDue(this.simulation?.readSnapshot(), true);
    }
    this.applyStart(commit);
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
    const intervalMs =
      this.phase === "network-pause" && this.peerReturnNoted
        ? RULES.network.recoveryProbeMs
        : RULES.network.keepaliveMs;
    if (!force && now - this.lastKeepaliveSentMs < intervalMs) return;
    this.lastKeepaliveSentMs = now;
    this.sendEnvelope("KEEPALIVE", {
      activeSessionId: this.options.identity.sessionId,
      resumeAvailable: !this.locallyHidden,
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

  private enterNetworkPause(
    announce: boolean,
    connectionIssue: boolean,
    adoptedEpoch?: number,
    issueStartedMs = this.options.clock.now(),
  ): void {
    if (this.phase === "finished") return;
    const cancelledInitialSync =
      this.syncPurpose === "initial" && this.config === null;
    if (cancelledInitialSync) {
      this.clearClockSyncLifecycle();
      this.localReady = false;
    }
    if (connectionIssue || (!this.locallyHidden && this.channelConnected)) {
      const observedIssueStartedMs = connectionIssue
        ? issueStartedMs
        : this.options.clock.now();
      this.connectionIncidentStartedMs = Math.min(
        this.connectionIncidentStartedMs ?? observedIssueStartedMs,
        observedIssueStartedMs,
      );
    }
    this.pauseRequiresOrientation ||= !connectionIssue;
    if (this.phase === "network-pause") {
      let repeatedPauseTrigger: PauseTrigger | null = null;
      if (adoptedEpoch !== undefined && adoptedEpoch > this.pauseEpoch) {
        this.pauseEpoch = adoptedEpoch;
        repeatedPauseTrigger = "peer-network-pause";
      } else if (announce && !connectionIssue) {
        this.pauseEpoch += 1;
        repeatedPauseTrigger = "visibility";
      }
      if (repeatedPauseTrigger !== null) {
        this.clearResumeHandshakeState();
        this.recordDiagnostic({
          kind: "connection-unstable",
          silenceMs: Math.floor(this.liveness.silentForMs()),
          pauseTick: this.pauseTick,
          pauseEpoch: this.pauseEpoch,
          pauseTrigger: repeatedPauseTrigger,
          telemetry: this.telemetry.snapshot(),
        });
        if (announce && this.channelConnected && this.config !== null) {
          this.announceNetworkPause(connectionIssue);
        }
      }
      return;
    }
    this.clearPendingStartLifecycle();
    const snapshot = this.simulation?.readSnapshot();
    this.pauseEpoch = adoptedEpoch ?? this.pauseEpoch + 1;
    this.pauseTick = snapshot?.tick ?? this.tickClock.pauseAt(this.options.clock.now());
    this.tickClock.pauseAt(this.options.clock.now());
    this.simulation?.setPaused(true);
    this.missingSinceMs = issueStartedMs;
    this.localResumeSent = false;
    this.remoteResumeReceived = false;
    this.remoteResumeTick = null;
    this.startScheduled = false;
    this.clockCommitReceived = false;
    this.transportRecoveryRequested = false;
    this.lastTransportRecoveryRequestMs = null;
    this.recoveryAttempt = 0;
    const pauseTrigger: PauseTrigger = announce
      ? connectionIssue
        ? "local-silence"
        : "visibility"
      : "peer-network-pause";
    this.diagnosticIncidentId =
      this.options.diagnostics?.begin({
        kind: "connection-unstable",
        silenceMs: Math.floor(this.liveness.silentForMs()),
        pauseTick: this.pauseTick,
        pauseEpoch: this.pauseEpoch,
        pauseTrigger,
        telemetry: this.telemetry.snapshot(),
      }, this.diagnosticContext()) ?? null;
    this.setPhase("network-pause");
    if (cancelledInitialSync && this.channelConnected) {
      this.sendEnvelope("READY", {
        ready: false,
        rulesHash: this.options.rulesHash,
      });
    }
    if (announce && this.channelConnected && this.config !== null) {
      this.announceNetworkPause(connectionIssue);
    }
  }

  private announceNetworkPause(connectionIssue: boolean): void {
    this.reliability.sendCritical(
      "NETWORK_PAUSE",
      {
        eventId: this.nextEventId("network-pause"),
        pauseEpoch: this.pauseEpoch,
        proposedPauseTick: this.pauseTick,
        connectionIssue,
      },
      this.pauseTick,
    );
  }

  private advanceSimulationTo(
    targetTick: Tick,
    deferGameplayReplay: boolean,
    source: RemoteTickSource,
  ): boolean {
    const simulation = this.simulation;
    if (simulation === null) return false;
    const initialTick = simulation.currentTick();
    if (Math.abs(targetTick - initialTick) > MAX_REMOTE_TICK_ADVANCE) {
      this.desynchronize("remote-tick-out-of-range", {
        source,
        localTick: initialTick,
        remoteTargetTick: targetTick,
        maxAllowedDeltaTicks: MAX_REMOTE_TICK_ADVANCE,
      });
      return false;
    }
    if (targetTick < initialTick) {
      const checkpoint = this.simulationCheckpoints.get(targetTick);
      if (checkpoint === undefined) {
        this.desynchronize("remote-tick-checkpoint-missing");
        return false;
      }
      simulation.restore(checkpoint);
      this.rewindGameplayJournal(targetTick);
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
      if (!deferGameplayReplay) {
        this.flushPendingGameplayCriticals();
        this.publishSnapshotIfDue(simulation.readSnapshot(), true);
      }
      return true;
    }
    if (targetTick === initialTick) {
      if (!deferGameplayReplay && this.flushPendingGameplayCriticals()) {
        this.snapshotScheduler.reset();
        this.publishSnapshotIfDue(undefined, true);
      }
      return true;
    }
    if (this.phase !== "playing") {
      return this.phase === "finished" &&
        this.terminal?.reason === "top-out" &&
        targetTick <= initialTick;
    }
    let snapshotDue = false;
    while (simulation.currentTick() < targetTick && this.phase === "playing") {
      const effects = simulation.tick(1);
      this.recordSimulationCheckpoint();
      this.publishEffects(effects);
      if (!deferGameplayReplay) this.flushPendingGameplayCriticals();
      if (
        this.phase === "playing" &&
        this.snapshotScheduler.claim(simulation.currentTick(), true)
      ) {
        snapshotDue = true;
      }
    }
    if (!deferGameplayReplay && this.flushPendingGameplayCriticals()) {
      this.snapshotScheduler.reset();
      this.publishSnapshotIfDue(undefined, true);
    } else if (snapshotDue && this.phase === "playing") {
      this.publishSnapshot(simulation.readSnapshot());
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
    const oldestCheckpointTick = Math.min(...this.simulationCheckpoints.keys());
    while (true) {
      const oldestEntry = this.gameplayJournal[0];
      if (
        oldestEntry === undefined ||
        oldestEntry.appliedAtTick === null ||
        oldestEntry.appliedAtTick > oldestCheckpointTick
      ) {
        break;
      }
      this.gameplayJournal.shift();
    }
  }

  private notePeerReturn(): void {
    this.peerPresent = true;
    if (
      this.phase !== "network-pause" ||
      this.peerReturnNoted ||
      this.locallyHidden
    ) {
      return;
    }
    this.peerReturnNoted = true;
    this.connectionIncidentStartedMs = this.options.clock.now();
    this.recordDiagnostic({
      kind: "peer-traffic-restored",
      pauseEpoch: this.pauseEpoch,
      telemetry: this.telemetry.snapshot(),
      ...(this.missingSinceMs === null
        ? {}
        : {
            silenceMs: Math.max(
              0,
              Math.floor(this.options.clock.now() - this.missingSinceMs),
            ),
          }),
    });
    this.missingSinceMs = null;
    this.transportRecoveryRequested = false;
    this.lastTransportRecoveryRequestMs = null;
    if (this.options.seat === "a") this.beginClockSync("resume");
    this.sendKeepalive(true);
  }

  private requestTransportRecovery(force = false): void {
    if (this.locallyHidden) return;
    const now = this.options.clock.now();
    if (
      !force &&
      this.lastTransportRecoveryRequestMs !== null &&
      now - this.lastTransportRecoveryRequestMs < this.transportRecoveryRetryMs()
    ) {
      return;
    }
    this.transportRecoveryRequested = true;
    this.lastTransportRecoveryRequestMs = now;
    this.recoveryAttempt += 1;
    this.recordDiagnostic({
      kind: "channel-replacement-requested",
      silenceMs: Math.floor(this.liveness.silentForMs()),
      pauseEpoch: this.pauseEpoch,
      attempt: this.recoveryAttempt,
      telemetry: this.telemetry.snapshot(),
    });
    let failed = false;
    try {
      failed = this.options.onTransportRecoveryNeeded?.() === false;
    } catch {
      failed = true;
    }
    if (failed) this.noteTransportRecoveryFailure(this.recoveryAttempt);
  }

  private transportRecoveryThresholdMs(): number {
    return (
      RULES.network.reconnectingMs +
      (this.options.seat === "b" ? RULES.network.reconnectSeatStaggerMs : 0)
    );
  }

  private transportRecoveryRetryMs(): number {
    return Math.min(
      RULES.network.reconnectRetryBaseMs *
        2 ** Math.max(0, this.recoveryAttempt - 1),
      RULES.network.reconnectRetryMaxMs,
    );
  }

  private clearResumeHandshakeState(): void {
    this.clearPendingStartLifecycle();
    this.clearClockSyncLifecycle();
    this.pendingClockCommit = null;
    this.clockCommitLastSentMs = null;
    this.clockCommitDeadlineMs = null;
    this.clockCommitReceived = false;
    this.localResumeSent = false;
    this.remoteResumeReceived = false;
    this.remoteResumeTick = null;
    this.peerReturnNoted = false;
  }

  private restartResumeHandshake(): void {
    if (this.phase !== "network-pause") return;
    this.clearResumeHandshakeState();
    this.requestTransportRecovery(true);
    if (
      this.phase === "network-pause" &&
      this.syncPurpose === null &&
      this.peerResumeAvailable &&
      !this.locallyHidden
    ) {
      this.peerReturnNoted = true;
      this.beginClockSync("resume");
    }
  }

  private sendResumeState(): void {
    if (this.localResumeSent || this.config === null || this.simulation === null) return;
    const snapshot = this.simulation.readSnapshot();
    this.localResumeSent = true;
    // A same-tick input can change the state hash after the last scheduled
    // snapshot. Give every authoritative resume snapshot a fresh sequence so
    // RemoteSnapshotStore cannot mistake that newer state for a stale frame.
    this.snapshotSequence += 1;
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
    this.recordDiagnostic({
      kind: "resume-state-sent",
      pauseTick: snapshot.tick,
      pauseEpoch: this.pauseEpoch,
    });
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
    const resumeSnapshotEnvelope: RealtimeEnvelope<"SNAPSHOT"> = {
      protocol: 1,
      matchId: envelope.matchId,
      senderId: envelope.senderId,
      sessionId: envelope.sessionId,
      kind: "SNAPSHOT",
      matchTick: envelope.payload.snapshot.stateTick,
      sentAtMonotonicMs: envelope.sentAtMonotonicMs,
      payload: envelope.payload.snapshot,
    };
    const acceptance = this.remoteSnapshots.acceptDetailed(resumeSnapshotEnvelope);
    if (acceptance.accepted) {
      this.remoteSnapshotsAccepted += 1;
      this.telemetry.noteSnapshotAccepted(
        resumeSnapshotEnvelope.payload.snapshotSeq,
      );
      this.lastRemoteSnapshotSeq = resumeSnapshotEnvelope.payload.snapshotSeq;
      this.lastRemoteSnapshotTick = resumeSnapshotEnvelope.payload.stateTick;
      this.lastRemoteSnapshotReceivedMs = this.options.clock.now();
    } else {
      const current = this.remoteSnapshots.latest(envelope.senderId);
      if (
        current === undefined ||
        current.snapshotSeq !== envelope.payload.snapshot.snapshotSeq ||
        current.stateTick !== envelope.payload.snapshot.stateTick ||
        current.stateHash !== envelope.payload.snapshot.stateHash
      ) {
        this.noteSnapshotRejected(acceptance.reason);
        return;
      }
    }
    for (const cursor of envelope.payload.inboundCritical) {
      this.reliability.acknowledgeCursor(cursor);
    }
    if (this.options.seat === "a") {
      // Seat B only emits a resume state after accepting CLOCK_COMMIT. This
      // reliable, epoch-bound progress is stronger evidence than the ephemeral
      // CONFIG_ACK: losing that one control frame must not restart the same
      // pause lifecycle while an acknowledged resume is already under way.
      this.pendingClockCommit = null;
      this.clockCommitLastSentMs = null;
      this.clockCommitDeadlineMs = null;
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
      this.remoteResumeTick === null ||
      this.startScheduled ||
      this.simulation === null
    ) {
      return;
    }
    const localTick = this.simulation.readSnapshot().tick;
    const commonTick = Math.min(localTick, this.remoteResumeTick);
    if (Math.abs(localTick - this.remoteResumeTick) > MAX_REMOTE_TICK_ADVANCE) {
      this.desynchronize("resume-state-tick-mismatch");
      return;
    }
    if (!this.advanceSimulationTo(commonTick, true, "resume-common-tick")) return;
    this.flushPendingGameplayCriticals(commonTick);
    this.snapshotScheduler.reset();
    this.publishSnapshotIfDue(this.simulation.readSnapshot(), true);
    this.recordDiagnostic({
      kind: "resume-countdown",
      pauseTick: commonTick,
      pauseEpoch: this.pauseEpoch,
      rollbackTicks: Math.max(localTick, this.remoteResumeTick) - commonTick,
    });
    const rollbackTicks = Math.max(localTick, this.remoteResumeTick) - commonTick;
    const countdownTicks =
      rollbackTicks > 0 || this.pauseRequiresOrientation
        ? RULES.network.rollbackResumeCountdownTicks
        : RULES.network.fastResumeCountdownTicks;
    this.scheduleStart(commonTick, this.pauseEpoch, countdownTicks);
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
      this.options.clock.now() + RULES.network.resultConsensusMs;
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

  private buildConnectionLostResult(): MatchResultV1 | null {
    if (this.config === null) return null;
    const localSnapshot = this.simulation?.readSnapshot();
    if (localSnapshot === undefined) return null;
    const remoteSnapshot = this.remoteSnapshots.latest(this.options.peer.senderId);
    const localStats = statsFromSnapshot(localSnapshot);
    const peerStats =
      remoteSnapshot === undefined ? emptyResultStats() : statsFromSnapshot(remoteSnapshot);
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
      reason: "connection-lost",
      durationTicks: this.pauseTick,
      finalLevel: Math.floor(this.pauseTick / RULES.timing.levelTicks) + 1,
      statsByPlayer: {
        [seatA.senderId]: cloneStats(
          this.options.seat === "a" ? localStats : peerStats,
        ),
        [seatB.senderId]: cloneStats(
          this.options.seat === "b" ? localStats : peerStats,
        ),
      },
      completedBy: seatA.senderId,
    };
  }

  private recordConnectionLost(): void {
    if (this.connectionLossRecorded || this.terminal !== null) return;
    this.connectionLossRecorded = true;
    this.simulation?.setPaused(true);
    this.clearClockSyncLifecycle();
    this.setTerminal({
      outcome: "desync",
      reason: "connection-lost",
      localTopOutTick: this.localTopOutTick,
      peerTopOutTick: this.peerTopOutTick,
    });
    this.recordDiagnostic({
      kind: "connection-lost",
      silenceMs: RULES.network.controllerReconnectGraceMs,
      pauseTick: this.pauseTick,
      pauseEpoch: this.pauseEpoch,
      telemetry: this.telemetry.snapshot(),
    });
    this.diagnosticIncidentId = null;
    const result = this.buildConnectionLostResult();
    if (result !== null) this.confirmedResult = cloneResult(result);
    this.setPhase("finished");
    if (result !== null && !this.durableResultEmitted) {
      this.durableResultEmitted = true;
      this.options.onResultConfirmed?.(cloneResult(result));
    }
  }

  private recordDiagnostic(event: NetworkDiagnosticEventInput): void {
    if (this.diagnosticIncidentId === null) return;
    this.options.diagnostics?.record(this.diagnosticIncidentId, event);
  }

  private diagnosticContext(): NetworkDiagnosticIncidentContext {
    return {
      matchId: this.options.matchId,
      localSeat: this.options.seat,
    };
  }

  private recordDesynchronization(
    reason: DesynchronizationReason,
    remoteTick?: RemoteTickDiagnosticContext,
  ): void {
    const diagnostics = this.options.diagnostics;
    if (diagnostics === undefined) return;
    const now = this.options.clock.now();
    const event: NetworkDiagnosticEventInput = {
      kind: "desynchronized",
      reason,
      snapshotsAccepted: this.remoteSnapshotsAccepted,
      snapshotsRejected: this.remoteSnapshotsRejected,
      ...(this.lastRemoteSnapshotSeq === null
        ? {}
        : { lastSnapshotSeq: this.lastRemoteSnapshotSeq }),
      ...(this.lastRemoteSnapshotTick === null
        ? {}
        : { lastSnapshotTick: this.lastRemoteSnapshotTick }),
      ...(this.lastRemoteSnapshotReceivedMs === null
        ? {}
        : {
            lastSnapshotAgeMs: Math.floor(
              Math.max(0, now - this.lastRemoteSnapshotReceivedMs),
            ),
          }),
      ...(this.lastPeerSnapshotSeq === null
        ? {}
        : { peerLastSnapshotSeq: this.lastPeerSnapshotSeq }),
      ...(this.lastSnapshotRejection === null
        ? {}
        : { lastSnapshotRejection: this.lastSnapshotRejection }),
      ...(remoteTick === undefined ? {} : { remoteTick }),
      telemetry: this.telemetry.snapshot(),
    };
    if (this.diagnosticIncidentId === null) {
      diagnostics.begin(event, this.diagnosticContext());
    } else {
      diagnostics.record(this.diagnosticIncidentId, event);
    }
    this.diagnosticIncidentId = null;
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
    this.clearPendingStartLifecycle();
    this.terminal = { ...terminal };
    this.options.onTerminal?.({ ...terminal });
  }
}
