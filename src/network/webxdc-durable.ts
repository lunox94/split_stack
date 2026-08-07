export interface DurableReceivedUpdate<T = unknown> {
  payload: T;
  serial: number;
  max_serial: number;
  info?: string;
  href?: string;
  summary?: string;
  notify?: Record<string, string>;
}

export interface DurableOutboundUpdate<T> {
  payload: T;
  info?: string;
  href?: string;
  summary?: string;
  notify?: Record<string, string>;
}

export interface DurableWebxdcHost<T = unknown> {
  selfAddr: string;
  selfName: string;
  sendUpdateInterval?: number;
  sendUpdateMaxSize?: number;
  sendUpdate(update: DurableOutboundUpdate<T>, description: string): void | Promise<void>;
  setUpdateListener(
    listener: (update: DurableReceivedUpdate<T>) => void,
    serial?: number,
  ): void | Promise<void>;
}

const DEFAULT_MAX_UPDATE_BYTES = 128_000;
const MAX_DURABLE_DEPTH = 8;
export const MAX_DURABLE_LOGICAL_CLOCK = 0x7fff_ffff;

export class DurableLamportClock {
  private value = 0;

  public observe(remoteValue: number): void {
    if (
      !Number.isSafeInteger(remoteValue) ||
      remoteValue < 0 ||
      remoteValue > MAX_DURABLE_LOGICAL_CLOCK
    ) {
      throw new RangeError("Lamport clock value is outside the supported range");
    }
    this.value = Math.max(this.value, remoteValue);
  }

  public next(): number {
    if (this.value >= MAX_DURABLE_LOGICAL_CLOCK) {
      throw new RangeError("Lamport clock exhausted its supported range");
    }
    this.value += 1;
    return this.value;
  }
}

function depthOf(value: unknown, current = 0, seen = new WeakSet<object>()): number {
  if (value === null || typeof value !== "object") return current;
  if (seen.has(value)) return Number.POSITIVE_INFINITY;
  if (current > MAX_DURABLE_DEPTH) return current;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  let maximum = current;
  try {
    for (const child of children) {
      maximum = Math.max(maximum, depthOf(child, current + 1, seen));
      if (maximum > MAX_DURABLE_DEPTH) return maximum;
    }
  } finally {
    seen.delete(value);
  }
  return maximum;
}

/**
 * Owns the process-wide setUpdateListener registration. The Webxdc API declares
 * repeated registration undefined, so consumers must fan out above this seam.
 */
export class WebxdcDurableLog<T = unknown> {
  private started = false;

  public constructor(private readonly host: DurableWebxdcHost<T>) {}

  public async start(
    listener: (update: DurableReceivedUpdate<T>) => void,
    lastKnownSerial = 0,
  ): Promise<void> {
    if (this.started) throw new Error("Durable update listener may be started only once");
    if (!Number.isSafeInteger(lastKnownSerial) || lastKnownSerial < 0) {
      throw new RangeError("Durable replay serial must be a non-negative integer");
    }
    this.started = true;
    await this.host.setUpdateListener(listener, lastKnownSerial);
  }

  public async append(update: DurableOutboundUpdate<T>): Promise<void> {
    const depth = depthOf(update);
    if (!Number.isFinite(depth)) {
      throw new TypeError("Durable update must be acyclic and JSON serializable");
    }
    if (depth > MAX_DURABLE_DEPTH) {
      throw new RangeError("Durable update exceeds maximum object depth");
    }
    let encoded: Uint8Array;
    try {
      encoded = new TextEncoder().encode(JSON.stringify(update));
    } catch {
      throw new TypeError("Durable update must be JSON serializable");
    }
    const maximum = this.host.sendUpdateMaxSize ?? DEFAULT_MAX_UPDATE_BYTES;
    if (encoded.byteLength > maximum) {
      throw new RangeError("Durable update exceeds host size limit");
    }
    // The legacy description parameter remains an empty string for old hosts.
    await this.host.sendUpdate(update, "");
  }
}

export interface LobbyActor {
  id: string;
  displayName: string;
}

interface LobbyEventBase {
  schema: "split-stack/lobby/v1";
  eventId: string;
  logicalClock: number;
  challengeId: string;
  actor: LobbyActor;
}

export interface ChallengeCreatedV1 extends LobbyEventBase {
  kind: "challenge-created";
  seatBVacancyId: string;
  rulesHash: string;
}

export interface SeatClaimedV1 extends LobbyEventBase {
  kind: "seat-claimed";
  vacancyId: string;
}

export interface SeatReleasedV1 extends LobbyEventBase {
  kind: "seat-released";
  occupancyEventId: string;
  nextVacancyId: string;
}

export interface ChallengeClosedV1 extends LobbyEventBase {
  kind: "challenge-closed";
}

export type LobbyEventV1 =
  | ChallengeCreatedV1
  | SeatClaimedV1
  | SeatReleasedV1
  | ChallengeClosedV1;

export interface SeatOccupant {
  playerId: string;
  displayName: string;
  occupancyEventId: string;
}

export interface MaterializedChallenge {
  challengeId: string;
  rulesHash: string;
  coordinatorPlayerId: string;
  seatA: SeatOccupant;
  seatB: SeatOccupant | null;
  currentSeatBVacancyId: string;
  closed: boolean;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

export function isLobbyEvent(value: unknown): value is LobbyEventV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  const actor = event.actor;
  if (typeof actor !== "object" || actor === null || Array.isArray(actor)) return false;
  const actorRecord = actor as Record<string, unknown>;
  if (
    event.schema !== "split-stack/lobby/v1" ||
    !["challenge-created", "seat-claimed", "seat-released", "challenge-closed"].includes(
      String(event.kind),
    ) ||
    !isBoundedString(event.eventId, 256) ||
    !Number.isSafeInteger(event.logicalClock) ||
    (event.logicalClock as number) < 1 ||
    (event.logicalClock as number) > MAX_DURABLE_LOGICAL_CLOCK ||
    !isBoundedString(event.challengeId, 256) ||
    !isBoundedString(actorRecord.id, 256) ||
    !isBoundedString(actorRecord.displayName, 128)
  ) {
    return false;
  }
  switch (event.kind) {
    case "challenge-created":
      return (
        isBoundedString(event.seatBVacancyId, 256) &&
        isBoundedString(event.rulesHash, 256)
      );
    case "seat-claimed":
      return isBoundedString(event.vacancyId, 256);
    case "seat-released":
      return (
        isBoundedString(event.occupancyEventId, 256) &&
        isBoundedString(event.nextVacancyId, 256)
      );
    case "challenge-closed":
      return true;
    default:
      return false;
  }
}

function compareLobbyEvents(left: LobbyEventV1, right: LobbyEventV1): number {
  return (
    left.logicalClock - right.logicalClock ||
    compareCodeUnits(left.actor.id, right.actor.id) ||
    compareCodeUnits(left.eventId, right.eventId) ||
    compareCodeUnits(left.kind, right.kind)
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Host update.serial is a local replay cursor, not a portable distributed
 * arbitration primitive. Seat claims therefore use an app-level Lamport tuple
 * (logicalClock, actor ID, event ID), giving every replica the same winner once
 * it has the same event set. Seat A remains coordinator for starts/rematches.
 */
export function materializeChallenge(
  candidates: readonly unknown[],
  challengeId: string,
): MaterializedChallenge | undefined {
  const sorted = candidates
    .filter(isLobbyEvent)
    .filter((event) => event.challengeId === challengeId)
    .sort(compareLobbyEvents);
  const deduplicated: LobbyEventV1[] = [];
  const seen = new Set<string>();
  for (const event of sorted) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    deduplicated.push(event);
  }
  const creationIndex = deduplicated.findIndex(
    (event): event is ChallengeCreatedV1 => event.kind === "challenge-created",
  );
  const creation = deduplicated[creationIndex];
  if (creation === undefined || creation.kind !== "challenge-created") return undefined;

  let seatB: SeatOccupant | null = null;
  let currentVacancy = creation.seatBVacancyId;
  let closed = false;
  for (let index = creationIndex + 1; index < deduplicated.length; index += 1) {
    const event = deduplicated[index];
    if (event === undefined || closed) continue;
    if (event.kind === "seat-claimed") {
      if (
        seatB === null &&
        event.vacancyId === currentVacancy &&
        event.actor.id !== creation.actor.id
      ) {
        seatB = {
          playerId: event.actor.id,
          displayName: event.actor.displayName,
          occupancyEventId: event.eventId,
        };
      }
    } else if (event.kind === "seat-released") {
      if (
        seatB !== null &&
        event.actor.id === seatB.playerId &&
        event.occupancyEventId === seatB.occupancyEventId
      ) {
        seatB = null;
        currentVacancy = event.nextVacancyId;
      }
    } else if (
      event.kind === "challenge-closed" &&
      event.actor.id === creation.actor.id
    ) {
      closed = true;
    }
  }

  return {
    challengeId,
    rulesHash: creation.rulesHash,
    coordinatorPlayerId: creation.actor.id,
    seatA: {
      playerId: creation.actor.id,
      displayName: creation.actor.displayName,
      occupancyEventId: creation.eventId,
    },
    seatB,
    currentSeatBVacancyId: currentVacancy,
    closed,
  };
}
