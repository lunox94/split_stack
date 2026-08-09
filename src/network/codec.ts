import { RULES } from "../config/rules";
import { isMatchResult } from "../persistence/history";
import {
  isCriticalKind,
  isMessageKind,
  type MessageKind,
  type RealtimeEnvelope,
} from "./messages";
import { isPlayerSnapshot } from "./snapshots";

export type DecodeError =
  | "too-large"
  | "invalid-utf8"
  | "invalid-json"
  | "too-deep"
  | "invalid-envelope"
  | "foreign-match"
  | "foreign-sender";

export type DecodeResult =
  | { ok: true; value: RealtimeEnvelope }
  | { ok: false; error: DecodeError };

export interface DecodeOptions {
  expectedMatchId?: string;
  allowedSenderIds?: ReadonlySet<string>;
  maxBytes?: number;
  maxDepth?: number;
}

const MAX_ID_LENGTH = 256;
const MAX_STRING_LENGTH = 4_096;
const MAX_CONTAINER_ENTRIES = 512;
const MAX_SEQUENCE = 0x7fff_ffff;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedJson(
  value: unknown,
  depth: number,
  maxDepth: number,
  seen = new WeakSet<object>(),
): boolean {
  if (depth > maxDepth) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= MAX_STRING_LENGTH;
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return (
        value.length <= MAX_CONTAINER_ENTRIES &&
        value.every((entry) => isBoundedJson(entry, depth + 1, maxDepth, seen))
      );
    }
    if (isRecord(value)) {
      const entries = Object.entries(value);
      return (
        entries.length <= MAX_CONTAINER_ENTRIES &&
        entries.every(
          ([key, entry]) =>
            key.length <= MAX_ID_LENGTH &&
            isBoundedJson(entry, depth + 1, maxDepth, seen),
        )
      );
    }
    return false;
  } finally {
    seen.delete(value);
  }
}

function exceedsDepth(value: unknown, depth: number, maxDepth: number): boolean {
  if (depth > maxDepth) return true;
  if (Array.isArray(value)) {
    return value.some((entry) => exceedsDepth(entry, depth + 1, maxDepth));
  }
  if (isRecord(value)) {
    return Object.values(value).some((entry) => exceedsDepth(entry, depth + 1, maxDepth));
  }
  return false;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isSafeCounter(value: unknown, allowZero = true): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= (allowZero ? 0 : 1) &&
    value <= MAX_SEQUENCE
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUint32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
}

function isPlayerResultStats(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const counters = [
    "score",
    "lines",
    "garbageSent",
    "powersActivated",
    "tetrises",
    "tSpinSingles",
    "tSpinDoubles",
    "tSpinTriples",
  ];
  return (
    counters.every((field) => isNonNegativeSafeInteger(value[field])) &&
    (value.topOutTick === undefined || isSafeCounter(value.topOutTick))
  );
}

function isOptionalBoundedString(value: unknown, maximum = MAX_ID_LENGTH): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maximum);
}

function isStream(value: unknown): boolean {
  return (
    isRecord(value) && isBoundedId(value.senderId) && isBoundedId(value.sessionId)
  );
}

function isStreamCursor(value: unknown): boolean {
  return (
    isRecord(value) &&
    isStream(value.stream) &&
    isSafeCounter(value.contiguousThrough)
  );
}

function isSequenceList(value: unknown, maximum: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((sequence) => isSafeCounter(sequence, false))
  );
}

function isCriticalApplicationReceipts(
  value: unknown,
  acknowledgedSequences: readonly number[],
): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > acknowledgedSequences.length) {
    return false;
  }
  const acknowledged = new Set(acknowledgedSequences);
  const seen = new Set<number>();
  return value.every((receipt) => {
    if (
      !isRecord(receipt) ||
      !isSafeCounter(receipt.sequence, false) ||
      !acknowledged.has(receipt.sequence) ||
      seen.has(receipt.sequence) ||
      (receipt.outcome !== "accepted" &&
        receipt.outcome !== "expired" &&
        receipt.outcome !== "rejected") ||
      !isFiniteNumber(receipt.processedAtMonotonicMs) ||
      receipt.processedAtMonotonicMs < 0
    ) {
      return false;
    }
    seen.add(receipt.sequence);
    return true;
  });
}

function hasEventId(payload: Record<string, unknown>): boolean {
  return isBoundedId(payload.eventId);
}

function isTargetEvent(payload: Record<string, unknown>): boolean {
  return hasEventId(payload) && isBoundedId(payload.targetPlayerId);
}

function isValidPayload(kind: MessageKind, payload: unknown): boolean {
  if (kind === "SNAPSHOT") return isPlayerSnapshot(payload);
  if (!isRecord(payload)) return false;
  switch (kind) {
    case "HELLO":
      return (
        typeof payload.displayName === "string" &&
        payload.displayName.length <= 128 &&
        typeof payload.resumeAvailable === "boolean" &&
        isOptionalBoundedString(payload.targetSessionId) &&
        (payload.transportGeneration === undefined ||
          isSafeCounter(payload.transportGeneration, false))
      );
    case "STATE_REQUEST":
      return (
        payload.targetPlayerIds === undefined ||
        (Array.isArray(payload.targetPlayerIds) &&
          payload.targetPlayerIds.length <= 16 &&
          payload.targetPlayerIds.every(isBoundedId))
      );
    case "READY":
      return (
        typeof payload.ready === "boolean" &&
        isBoundedId(payload.rulesHash) &&
        (payload.supportsStartCommitReceipts === undefined ||
          typeof payload.supportsStartCommitReceipts === "boolean")
      );
    case "CLOCK_PING":
      return isSafeCounter(payload.sampleId) && isFiniteNumber(payload.coordinatorSentMs);
    case "CLOCK_PONG":
      return (
        isSafeCounter(payload.sampleId) &&
        isFiniteNumber(payload.coordinatorSentMs) &&
        isFiniteNumber(payload.peerReceivedMs) &&
        isFiniteNumber(payload.peerSentMs)
      );
    case "CLOCK_COMMIT":
      return (
        isFiniteNumber(payload.offsetPeerMinusCoordinatorMs) &&
        Array.isArray(payload.sampleIds) &&
        payload.sampleIds.length === 3 &&
        payload.sampleIds.every((sampleId) => isSafeCounter(sampleId))
      );
    case "CONFIG_ACK":
      return (
        isBoundedId(payload.configHash) &&
        typeof payload.accepted === "boolean" &&
        isOptionalBoundedString(payload.reason)
      );
    case "ACK":
      return (
        isStream(payload.stream) &&
        isSequenceList(payload.seqs, RULES.network.maxPendingCritical) &&
        isCriticalApplicationReceipts(
          payload.applicationReceipts,
          payload.seqs,
        )
      );
    case "GAP_REQUEST":
      return (
        isStream(payload.stream) &&
        isSafeCounter(payload.fromSeq, false) &&
        isSafeCounter(payload.throughSeq, false) &&
        payload.throughSeq >= payload.fromSeq &&
        payload.throughSeq - payload.fromSeq < RULES.network.maxPendingCritical
      );
    case "KEEPALIVE":
      return (
        isBoundedId(payload.activeSessionId) &&
        typeof payload.resumeAvailable === "boolean" &&
        (payload.transportGeneration === undefined ||
          isSafeCounter(payload.transportGeneration, false)) &&
        isSafeCounter(payload.lastSnapshotSeq) &&
        (payload.lastAcceptedSnapshotSeq === undefined ||
          isSafeCounter(payload.lastAcceptedSnapshotSeq)) &&
        (payload.probeSeq === undefined ||
          isSafeCounter(payload.probeSeq, false)) &&
        (payload.echoProbeSeq === undefined ||
          isSafeCounter(payload.echoProbeSeq, false)) &&
        Array.isArray(payload.inboundCritical) &&
        payload.inboundCritical.length <= 16 &&
        payload.inboundCritical.every(
          (cursor) =>
            isRecord(cursor) &&
            isStream(cursor.stream) &&
            isSafeCounter(cursor.contiguousThrough),
        )
      );
    case "MATCH_CONFIG":
      return (
        hasEventId(payload) &&
        payload.rulesVersion === RULES.rulesVersion &&
        isBoundedId(payload.rulesHash) &&
        isBoundedId(payload.configHash) &&
        typeof payload.seed === "string" &&
        /^[0-9a-f]{32}$/i.test(payload.seed) &&
        isBoundedId(payload.coordinatorPlayerId) &&
        isBoundedId(payload.seatAPlayerId) &&
        isBoundedId(payload.seatBPlayerId) &&
        payload.seatAPlayerId !== payload.seatBPlayerId &&
        payload.coordinatorPlayerId === payload.seatAPlayerId
      );
    case "RESUME_STATE":
      return (
        hasEventId(payload) &&
        isSafeCounter(payload.pauseEpoch, false) &&
        isBoundedId(payload.configHash) &&
        isPlayerSnapshot(payload.snapshot) &&
        Array.isArray(payload.inboundCritical) &&
        payload.inboundCritical.length <= 16 &&
        payload.inboundCritical.every(isStreamCursor)
      );
    case "START":
      return (
        hasEventId(payload) &&
        isSafeCounter(payload.epoch) &&
        isFiniteNumber(payload.startAtCoordinatorMs) &&
        payload.startAtCoordinatorMs >= 0 &&
        isSafeCounter(payload.startTick) &&
        isBoundedId(payload.configHash)
      );
    case "START_COMMIT":
      return (
        hasEventId(payload) &&
        isBoundedId(payload.proposalEventId) &&
        isSafeCounter(payload.epoch) &&
        isFiniteNumber(payload.startAtCoordinatorMs) &&
        payload.startAtCoordinatorMs >= 0 &&
        isSafeCounter(payload.startTick) &&
        isBoundedId(payload.configHash)
      );
    case "GARBAGE_ATTACK":
      return (
        isTargetEvent(payload) &&
        isSafeCounter(payload.rows, false) &&
        payload.rows <= 256
      );
    case "HOLLOW_CROSS":
    case "GLITCH_PIECE":
    case "OVERSIZE_PIECE":
    case "SCRAMBLE_START":
    case "GHOST_JAM_START":
      return isTargetEvent(payload);
    case "BLACKOUT_START":
      return hasEventId(payload) && isBoundedId(payload.ownerPlayerId);
    case "TOP_OUT":
      return (
        hasEventId(payload) &&
        isBoundedId(payload.playerId) &&
        (payload.reason === "spawn-collision" || payload.reason === "garbage-overflow") &&
        isUint32(payload.stateHash) &&
        isSafeCounter(payload.finalLevel, false) &&
        isPlayerResultStats(payload.finalStats)
      );
    case "FORFEIT":
      return (
        hasEventId(payload) &&
        isBoundedId(payload.forfeitingPlayerId) &&
        isBoundedId(payload.resultHash) &&
        isMatchResult(payload.result)
      );
    case "NETWORK_PAUSE":
      return (
        hasEventId(payload) &&
        isSafeCounter(payload.pauseEpoch) &&
        isSafeCounter(payload.proposedPauseTick) &&
        typeof payload.connectionIssue === "boolean"
      );
    case "RESULT_CONFIRM":
      return (
        hasEventId(payload) &&
        isBoundedId(payload.resultHash) &&
        isMatchResult(payload.result)
      );
    default:
      return false;
  }
}

function isValidEnvelope(value: unknown): value is RealtimeEnvelope {
  if (!isRecord(value) || value.protocol !== 1 || !isMessageKind(value.kind)) return false;
  if (
    !isBoundedId(value.matchId) ||
    !isBoundedId(value.senderId) ||
    !isBoundedId(value.sessionId) ||
    !isSafeCounter(value.matchTick) ||
    typeof value.sentAtMonotonicMs !== "number" ||
    !Number.isFinite(value.sentAtMonotonicMs) ||
    value.sentAtMonotonicMs < 0 ||
    !("payload" in value)
  ) {
    return false;
  }

  const kind = value.kind as MessageKind;
  if (!isValidPayload(kind, value.payload)) return false;
  if (isRecord(value.payload)) {
    if (
      (kind === "TOP_OUT" &&
        (value.payload.playerId !== value.senderId ||
          !isRecord(value.payload.finalStats) ||
          value.payload.finalStats.topOutTick !== value.matchTick)) ||
      (kind === "FORFEIT" &&
        (value.payload.forfeitingPlayerId !== value.senderId ||
          !isRecord(value.payload.result) ||
          value.payload.result.matchId !== value.matchId ||
          value.payload.result.completedBy !== value.senderId)) ||
      (kind === "BLACKOUT_START" && value.payload.ownerPlayerId !== value.senderId) ||
      (kind === "MATCH_CONFIG" && value.payload.coordinatorPlayerId !== value.senderId) ||
      (kind === "RESUME_STATE" &&
        isRecord(value.payload.snapshot) &&
        value.payload.snapshot.playerId !== value.senderId)
    ) {
      return false;
    }
  }
  if (isCriticalKind(kind)) {
    if (!isSafeCounter(value.seq, false) || !isRecord(value.payload)) return false;
    return isBoundedId(value.payload.eventId);
  }
  return value.seq === undefined || isSafeCounter(value.seq, false);
}

export function decodeEnvelope(
  data: Uint8Array,
  options: DecodeOptions = {},
): DecodeResult {
  const maxBytes = options.maxBytes ?? RULES.network.maxRealtimeBytes;
  if (data.byteLength > maxBytes) return { ok: false, error: "too-large" };

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return { ok: false, error: "invalid-utf8" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: "invalid-json" };
  }

  // Realtime channels are chat-wide. Reject a bounded foreign header before
  // walking or validating its potentially large snapshot payload so each
  // concurrent match pays only the JSON parse plus a constant-time route check.
  if (!isRecord(parsed) || !isBoundedId(parsed.matchId) || !isBoundedId(parsed.senderId)) {
    return { ok: false, error: "invalid-envelope" };
  }
  if (options.expectedMatchId !== undefined && parsed.matchId !== options.expectedMatchId) {
    return { ok: false, error: "foreign-match" };
  }
  if (
    options.allowedSenderIds !== undefined &&
    !options.allowedSenderIds.has(parsed.senderId)
  ) {
    return { ok: false, error: "foreign-sender" };
  }

  const maxDepth = options.maxDepth ?? RULES.network.maxMessageDepth;
  if (exceedsDepth(parsed, 0, maxDepth)) return { ok: false, error: "too-deep" };
  if (!isBoundedJson(parsed, 0, maxDepth) || !isValidEnvelope(parsed)) {
    return { ok: false, error: "invalid-envelope" };
  }
  if (parsed.kind === "SNAPSHOT" && data.byteLength > RULES.network.maxSnapshotBytes) {
    return { ok: false, error: "too-large" };
  }
  return { ok: true, value: parsed };
}

export function encodeEnvelope(envelope: RealtimeEnvelope): Uint8Array {
  if (!isBoundedJson(envelope, 0, RULES.network.maxMessageDepth) || !isValidEnvelope(envelope)) {
    throw new TypeError("Invalid realtime envelope");
  }
  const encoded = new TextEncoder().encode(JSON.stringify(envelope));
  if (envelope.kind === "SNAPSHOT" && encoded.byteLength > RULES.network.maxSnapshotBytes) {
    throw new RangeError("Snapshot envelope exceeds maximum size");
  }
  if (encoded.byteLength > RULES.network.maxRealtimeBytes) {
    throw new RangeError("Realtime envelope exceeds maximum size");
  }
  return encoded;
}
