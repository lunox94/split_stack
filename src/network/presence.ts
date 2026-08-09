import type { MonotonicClock } from "./clock";

export const PRESENCE_SCHEMA = "split-stack/presence/v2" as const;
export const DEFAULT_PRESENCE_MAX_AGE_MS = 15_000;
export const DEFAULT_PRESENCE_MAX_FRAME_BYTES = 1_024;
export const DEFAULT_PRESENCE_MAX_ENTRIES = 512;

const MAX_ID_CHARACTERS = 256;
const MAX_DISPLAY_NAME_CHARACTERS = 128;

export interface PresenceActor {
  id: string;
  displayName: string;
}

/**
 * Passive chat presence. It carries no readiness, seat, or matchmaking claim
 * and must never be used to accept or reject an authoritative durable event.
 */
export interface PresenceFrame {
  schema: typeof PRESENCE_SCHEMA;
  actor: PresenceActor;
  challengeId: string;
  runtimeId: string;
}

export type PresenceDecodeError =
  | "too-large"
  | "invalid-utf8"
  | "invalid-json"
  | "invalid-frame";

export type PresenceDecodeResult =
  | { ok: true; value: PresenceFrame }
  | { ok: false; error: PresenceDecodeError };

export interface PresenceDecodeOptions {
  maxBytes?: number;
}

export interface AdvisoryPresenceTrackerOptions {
  clock?: MonotonicClock;
  maxAgeMs?: number;
  maxEntries?: number;
  maxFrameBytes?: number;
}

export interface PresenceObservation {
  actor: PresenceActor;
  challengeId: string;
  runtimeId: string;
  lastSeenAtMs: number;
}

export interface AdvisoryPresenceStatus {
  actorId: string;
  challengeId: string;
  online: boolean;
  lastSeenAtMs: number | null;
  runtimeIds: string[];
}

export interface PresenceListOptions {
  challengeId?: string;
  atMs?: number;
}

interface TrackedPresence {
  frame: PresenceFrame;
  lastSeenAtMs: number;
}

const systemClock: MonotonicClock = {
  now: () => performance.now(),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function assertMaximumBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Presence frame byte limit must be a positive safe integer");
  }
  return value;
}

function assertTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Presence receive time must be finite and non-negative");
  }
  return value;
}

function assertMaxAge(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Presence maximum age must be finite and non-negative");
  }
  return value;
}

function assertMaximumEntries(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Presence entry limit must be a positive safe integer");
  }
  return value;
}

function assertLookupId(value: string, label: string): string {
  if (!isBoundedString(value, MAX_ID_CHARACTERS)) {
    throw new RangeError(`${label} must contain 1-${MAX_ID_CHARACTERS} characters`);
  }
  return value;
}

function cloneFrame(frame: PresenceFrame): PresenceFrame {
  return {
    schema: PRESENCE_SCHEMA,
    actor: { ...frame.actor },
    challengeId: frame.challengeId,
    runtimeId: frame.runtimeId,
  };
}

function trackingKey(frame: PresenceFrame): string {
  return `${frame.actor.id.length}:${frame.actor.id}` +
    `${frame.challengeId.length}:${frame.challengeId}` +
    `${frame.runtimeId.length}:${frame.runtimeId}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function isPresenceFrame(value: unknown): value is PresenceFrame {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schema", "actor", "challengeId", "runtimeId"]) ||
    value.schema !== PRESENCE_SCHEMA ||
    !isRecord(value.actor) ||
    !hasExactKeys(value.actor, ["id", "displayName"])
  ) {
    return false;
  }
  return (
    isBoundedString(value.actor.id, MAX_ID_CHARACTERS) &&
    isBoundedString(value.actor.displayName, MAX_DISPLAY_NAME_CHARACTERS) &&
    isBoundedString(value.challengeId, MAX_ID_CHARACTERS) &&
    isBoundedString(value.runtimeId, MAX_ID_CHARACTERS)
  );
}

export function encodePresenceFrame(
  frame: PresenceFrame,
  options: PresenceDecodeOptions = {},
): Uint8Array {
  if (!isPresenceFrame(frame)) {
    throw new TypeError("Invalid advisory presence frame");
  }
  const maximum = assertMaximumBytes(
    options.maxBytes ?? DEFAULT_PRESENCE_MAX_FRAME_BYTES,
  );
  const encoded = new TextEncoder().encode(JSON.stringify(frame));
  if (encoded.byteLength > maximum) {
    throw new RangeError("Presence frame exceeds byte limit");
  }
  return encoded;
}

export function decodePresenceFrame(
  data: Uint8Array,
  options: PresenceDecodeOptions = {},
): PresenceDecodeResult {
  const maximum = assertMaximumBytes(
    options.maxBytes ?? DEFAULT_PRESENCE_MAX_FRAME_BYTES,
  );
  if (data.byteLength > maximum) return { ok: false, error: "too-large" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return { ok: false, error: "invalid-utf8" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid-json" };
  }
  if (!isPresenceFrame(parsed)) return { ok: false, error: "invalid-frame" };
  return { ok: true, value: cloneFrame(parsed) };
}

/**
 * Receiver-local advisory presence over the shared realtime hub. Freshness is
 * deliberately absent from durable tournament arbitration.
 */
export class AdvisoryPresenceTracker {
  private readonly clock: MonotonicClock;
  private readonly maxAgeMs: number;
  private readonly maxEntries: number;
  private readonly maxFrameBytes: number;
  private readonly entries = new Map<string, TrackedPresence>();

  public constructor(options: AdvisoryPresenceTrackerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.maxAgeMs = assertMaxAge(
      options.maxAgeMs ?? DEFAULT_PRESENCE_MAX_AGE_MS,
    );
    this.maxEntries = assertMaximumEntries(
      options.maxEntries ?? DEFAULT_PRESENCE_MAX_ENTRIES,
    );
    this.maxFrameBytes = assertMaximumBytes(
      options.maxFrameBytes ?? DEFAULT_PRESENCE_MAX_FRAME_BYTES,
    );
    assertTimestamp(this.clock.now());
  }

  /** Suitable as a RealtimeHub subscriber; non-presence frames are ignored. */
  public receive(data: Uint8Array): PresenceDecodeResult {
    const decoded = decodePresenceFrame(data, { maxBytes: this.maxFrameBytes });
    if (decoded.ok) this.observe(decoded.value);
    return decoded;
  }

  public observe(
    frame: PresenceFrame,
    receivedAtMs = this.clock.now(),
  ): void {
    if (!isPresenceFrame(frame)) throw new TypeError("Invalid advisory presence frame");
    const receivedAt = assertTimestamp(receivedAtMs);
    const key = trackingKey(frame);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (receivedAt >= existing.lastSeenAtMs) {
        existing.frame = cloneFrame(frame);
        existing.lastSeenAtMs = receivedAt;
      }
      return;
    }
    if (this.entries.size >= this.maxEntries) {
      this.evictExpired(receivedAt);
    }
    while (this.entries.size >= this.maxEntries) this.evictOldest();
    this.entries.set(key, { frame: cloneFrame(frame), lastSeenAtMs: receivedAt });
  }

  public isOnline(
    actorId: string,
    challengeId: string,
    atMs = this.clock.now(),
  ): boolean {
    return this.status(actorId, challengeId, atMs).online;
  }

  public status(
    actorId: string,
    challengeId: string,
    atMs = this.clock.now(),
  ): AdvisoryPresenceStatus {
    assertLookupId(actorId, "Presence actor ID");
    assertLookupId(challengeId, "Presence challenge ID");
    const now = assertTimestamp(atMs);
    let lastSeenAtMs: number | null = null;
    const runtimeIds: string[] = [];
    for (const tracked of this.entries.values()) {
      if (
        tracked.frame.actor.id !== actorId ||
        tracked.frame.challengeId !== challengeId
      ) {
        continue;
      }
      lastSeenAtMs = Math.max(lastSeenAtMs ?? 0, tracked.lastSeenAtMs);
      if (this.isFresh(tracked, now)) runtimeIds.push(tracked.frame.runtimeId);
    }
    runtimeIds.sort(compareCodeUnits);
    return {
      actorId,
      challengeId,
      online: runtimeIds.length > 0,
      lastSeenAtMs,
      runtimeIds,
    };
  }

  public listOnline(options: PresenceListOptions = {}): PresenceObservation[] {
    const now = assertTimestamp(options.atMs ?? this.clock.now());
    const challengeId = options.challengeId === undefined
      ? undefined
      : assertLookupId(options.challengeId, "Presence challenge ID");
    return [...this.entries.values()]
      .filter(
        (tracked) =>
          this.isFresh(tracked, now) &&
          (challengeId === undefined || tracked.frame.challengeId === challengeId),
      )
      .sort(
        (left, right) =>
          compareCodeUnits(left.frame.actor.id, right.frame.actor.id) ||
          compareCodeUnits(left.frame.challengeId, right.frame.challengeId) ||
          compareCodeUnits(left.frame.runtimeId, right.frame.runtimeId),
      )
      .map((tracked) => ({
        actor: { ...tracked.frame.actor },
        challengeId: tracked.frame.challengeId,
        runtimeId: tracked.frame.runtimeId,
        lastSeenAtMs: tracked.lastSeenAtMs,
      }));
  }

  private isFresh(tracked: TrackedPresence, atMs: number): boolean {
    return Math.max(0, atMs - tracked.lastSeenAtMs) <= this.maxAgeMs;
  }

  private evictExpired(atMs: number): void {
    for (const [key, tracked] of this.entries) {
      if (!this.isFresh(tracked, atMs)) this.entries.delete(key);
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, tracked] of this.entries) {
      if (
        tracked.lastSeenAtMs < oldestAt ||
        (tracked.lastSeenAtMs === oldestAt &&
          oldestKey !== null &&
          compareCodeUnits(key, oldestKey) < 0)
      ) {
        oldestKey = key;
        oldestAt = tracked.lastSeenAtMs;
      }
    }
    if (oldestKey !== null) this.entries.delete(oldestKey);
  }
}
