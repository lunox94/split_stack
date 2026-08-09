import type {
  MatchResultV1,
  PlayerId,
  PlayerResultStats,
  Tick,
} from "../domain/types";
import type { PlayerSnapshotV1 } from "./snapshots";

export type SessionId = string;

export interface StreamRef {
  senderId: PlayerId;
  sessionId: SessionId;
}

export interface StreamCursor {
  stream: StreamRef;
  contiguousThrough: number;
}

export interface CriticalPayload {
  eventId: string;
}

export type CriticalApplicationOutcome =
  | "accepted"
  | "expired"
  | "rejected";

export interface CriticalApplicationReceipt {
  sequence: number;
  outcome: CriticalApplicationOutcome;
  processedAtMonotonicMs: number;
}

export interface MatchConfigPayload extends CriticalPayload {
  rulesVersion: 2;
  rulesHash: string;
  configHash: string;
  seed: string;
  coordinatorPlayerId: PlayerId;
  seatAPlayerId: PlayerId;
  seatBPlayerId: PlayerId;
}

export interface ResumeStatePayload extends CriticalPayload {
  pauseEpoch: number;
  configHash: string;
  snapshot: PlayerSnapshotV1;
  inboundCritical: StreamCursor[];
}

export const MESSAGE_KINDS = [
  "HELLO",
  "STATE_REQUEST",
  "READY",
  "CLOCK_PING",
  "CLOCK_PONG",
  "CLOCK_COMMIT",
  "CONFIG_ACK",
  "ACK",
  "GAP_REQUEST",
  "KEEPALIVE",
  "SNAPSHOT",
  "MATCH_CONFIG",
  "START",
  "START_COMMIT",
  "GARBAGE_ATTACK",
  "HOLLOW_CROSS",
  "GLITCH_PIECE",
  "OVERSIZE_PIECE",
  "SCRAMBLE_START",
  "GHOST_JAM_START",
  "BLACKOUT_START",
  "TOP_OUT",
  "FORFEIT",
  "NETWORK_PAUSE",
  "RESUME_STATE",
  "RESULT_CONFIRM",
] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const CRITICAL_KINDS = [
  "MATCH_CONFIG",
  "START",
  "START_COMMIT",
  "GARBAGE_ATTACK",
  "HOLLOW_CROSS",
  "GLITCH_PIECE",
  "OVERSIZE_PIECE",
  "SCRAMBLE_START",
  "GHOST_JAM_START",
  "BLACKOUT_START",
  "TOP_OUT",
  "FORFEIT",
  "NETWORK_PAUSE",
  "RESUME_STATE",
  "RESULT_CONFIRM",
] as const satisfies readonly MessageKind[];

export type CriticalKind = (typeof CRITICAL_KINDS)[number];

const MESSAGE_KIND_SET = new Set<string>(MESSAGE_KINDS);
const CRITICAL_KIND_SET = new Set<string>(CRITICAL_KINDS);

export function isMessageKind(value: unknown): value is MessageKind {
  return typeof value === "string" && MESSAGE_KIND_SET.has(value);
}

export function isCriticalKind(value: MessageKind): value is CriticalKind {
  return CRITICAL_KIND_SET.has(value);
}

export interface RealtimePayloadMap {
  HELLO: {
    displayName: string;
    targetSessionId?: SessionId;
    resumeAvailable: boolean;
    /** Monotonic per-session transport attachment. */
    transportGeneration?: number;
  };
  STATE_REQUEST: { targetPlayerIds?: PlayerId[] };
  READY: {
    ready: boolean;
    rulesHash: string;
    /** Advertises receiver-stamped START_COMMIT decisions. */
    supportsStartCommitReceipts?: boolean;
  };
  // A sample ID names one transmission attempt. Retries use a fresh ID and
  // preserve this attempt's exact send time so delayed replies remain valid.
  CLOCK_PING: { sampleId: number; coordinatorSentMs: number };
  CLOCK_PONG: {
    sampleId: number;
    coordinatorSentMs: number;
    peerReceivedMs: number;
    peerSentMs: number;
  };
  CLOCK_COMMIT: {
    offsetPeerMinusCoordinatorMs: number;
    sampleIds: number[];
  };
  CONFIG_ACK: { configHash: string; accepted: boolean; reason?: string };
  ACK: {
    stream: StreamRef;
    seqs: number[];
    /** Semantic decisions that cursors alone cannot safely infer. */
    applicationReceipts?: CriticalApplicationReceipt[];
  };
  GAP_REQUEST: { stream: StreamRef; fromSeq: number; throughSeq: number };
  KEEPALIVE: {
    activeSessionId: SessionId;
    resumeAvailable: boolean;
    /** Monotonic per-session transport attachment. */
    transportGeneration?: number;
    lastSnapshotSeq: number;
    /** Latest snapshot from the receiver that this sender has accepted. */
    lastAcceptedSnapshotSeq?: number;
    /** Monotonic delivery probe originated by this sender. */
    probeSeq?: number;
    /** Latest delivery probe received from the peer. */
    echoProbeSeq?: number;
    inboundCritical: StreamCursor[];
  };
  SNAPSHOT: PlayerSnapshotV1;
  MATCH_CONFIG: MatchConfigPayload;
  START: CriticalPayload & {
    epoch: number;
    startAtCoordinatorMs: number;
    startTick: Tick;
    configHash: string;
  };
  START_COMMIT: CriticalPayload & {
    proposalEventId: string;
    epoch: number;
    startAtCoordinatorMs: number;
    startTick: Tick;
    configHash: string;
  };
  GARBAGE_ATTACK: CriticalPayload & {
    targetPlayerId: PlayerId;
    rows: number;
  };
  HOLLOW_CROSS: CriticalPayload & { targetPlayerId: PlayerId };
  GLITCH_PIECE: CriticalPayload & { targetPlayerId: PlayerId };
  OVERSIZE_PIECE: CriticalPayload & { targetPlayerId: PlayerId };
  SCRAMBLE_START: CriticalPayload & { targetPlayerId: PlayerId };
  GHOST_JAM_START: CriticalPayload & { targetPlayerId: PlayerId };
  BLACKOUT_START: CriticalPayload & { ownerPlayerId: PlayerId };
  TOP_OUT: CriticalPayload & {
    playerId: PlayerId;
    reason: "spawn-collision" | "garbage-overflow";
    stateHash: number;
    finalLevel: number;
    finalStats: PlayerResultStats;
  };
  FORFEIT: CriticalPayload & {
    forfeitingPlayerId: PlayerId;
    resultHash: string;
    result: MatchResultV1;
  };
  NETWORK_PAUSE: CriticalPayload & {
    pauseEpoch: number;
    proposedPauseTick: Tick;
    connectionIssue: boolean;
  };
  RESUME_STATE: ResumeStatePayload;
  RESULT_CONFIRM: CriticalPayload & {
    resultHash: string;
    result: MatchResultV1;
  };
}

export type RealtimeEnvelope<K extends MessageKind = MessageKind> = K extends MessageKind
  ? {
      protocol: 1;
      matchId: string;
      senderId: PlayerId;
      sessionId: SessionId;
      kind: K;
      seq?: number;
      matchTick: Tick;
      sentAtMonotonicMs: number;
      payload: RealtimePayloadMap[K];
    }
  : never;

export function streamKey(stream: StreamRef): string {
  return `${stream.senderId.length}:${stream.senderId}${stream.sessionId.length}:${stream.sessionId}`;
}

export function envelopeStream(envelope: RealtimeEnvelope): StreamRef {
  return { senderId: envelope.senderId, sessionId: envelope.sessionId };
}
