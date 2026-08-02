/**
 * Durable, per-seat election for browser runtimes owned by one Webxdc actor.
 *
 * Only claims received back through the durable update listener belong in this
 * materializer. An outbound claim is therefore not authoritative until the
 * host echoes it and `isLocalClaimConfirmed()` becomes true. At that instant a
 * newer runtime takes control and every older runtime observing the same log
 * deterministically yields.
 */

import { MAX_DURABLE_LOGICAL_CLOCK } from "../network/webxdc-durable";

export const SESSION_CLAIM_SCHEMA = "split-stack/session-claim/v1" as const;
export const MAX_RETAINED_SESSION_CLAIMS = 64;
const DEFAULT_RETAINED_SESSION_CLAIMS = 32;

const CLAIM_KEYS = [
  "actor",
  "challengeId",
  "eventId",
  "kind",
  "logicalClock",
  "occupancyEventId",
  "runtimeSessionId",
  "schema",
] as const;
const ACTOR_KEYS = ["displayName", "id"] as const;

export interface SessionClaimActor {
  readonly id: string;
  readonly displayName: string;
}

export interface SessionClaimV1 {
  readonly schema: typeof SESSION_CLAIM_SCHEMA;
  readonly kind: "session-claim";
  readonly challengeId: string;
  readonly occupancyEventId: string;
  readonly runtimeSessionId: string;
  readonly actor: SessionClaimActor;
  readonly logicalClock: number;
  readonly eventId: string;
}

export interface SessionElectionScope {
  readonly challengeId: string;
  readonly occupancyEventId: string;
  /** The local `webxdc.selfAddr`; never expose this value in presentation UI. */
  readonly actorId: string;
}

export interface RuntimeSessionElectionOptions {
  readonly maxClaims?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

/** Strictly validates the complete JSON payload, including rejection of extras. */
export function isSessionClaim(value: unknown): value is SessionClaimV1 {
  try {
    if (!isRecord(value) || !hasExactKeys(value, CLAIM_KEYS)) return false;
    const actor = value.actor;
    if (!isRecord(actor) || !hasExactKeys(actor, ACTOR_KEYS)) return false;
    return (
      value.schema === SESSION_CLAIM_SCHEMA &&
      value.kind === "session-claim" &&
      isBoundedString(value.challengeId, 256) &&
      isBoundedString(value.occupancyEventId, 256) &&
      isBoundedString(value.runtimeSessionId, 128) &&
      isBoundedString(value.eventId, 256) &&
      Number.isSafeInteger(value.logicalClock) &&
      (value.logicalClock as number) >= 1 &&
      (value.logicalClock as number) <= MAX_DURABLE_LOGICAL_CLOCK &&
      isBoundedString(actor.id, 256) &&
      isBoundedString(actor.displayName, 128)
    );
  } catch {
    return false;
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Positive means `left` is the newer deterministic claim. */
export function compareSessionClaimNewness(
  left: SessionClaimV1,
  right: SessionClaimV1,
): number {
  if (left.logicalClock !== right.logicalClock) {
    return left.logicalClock < right.logicalClock ? -1 : 1;
  }
  return (
    compareCodeUnits(left.eventId, right.eventId) ||
    compareCodeUnits(left.runtimeSessionId, right.runtimeSessionId) ||
    compareCodeUnits(left.actor.id, right.actor.id) ||
    compareCodeUnits(left.challengeId, right.challengeId) ||
    compareCodeUnits(left.occupancyEventId, right.occupancyEventId) ||
    compareCodeUnits(left.actor.displayName, right.actor.displayName)
  );
}

function cloneClaim(claim: SessionClaimV1): SessionClaimV1 {
  return {
    schema: SESSION_CLAIM_SCHEMA,
    kind: "session-claim",
    challengeId: claim.challengeId,
    occupancyEventId: claim.occupancyEventId,
    runtimeSessionId: claim.runtimeSessionId,
    actor: { id: claim.actor.id, displayName: claim.actor.displayName },
    logicalClock: claim.logicalClock,
    eventId: claim.eventId,
  };
}

function claimFingerprint(claim: SessionClaimV1): string {
  return JSON.stringify([
    claim.schema,
    claim.kind,
    claim.challengeId,
    claim.occupancyEventId,
    claim.runtimeSessionId,
    claim.actor.id,
    claim.actor.displayName,
    claim.logicalClock,
    claim.eventId,
  ]);
}

function scopeMatches(claim: SessionClaimV1, scope: SessionElectionScope): boolean {
  return (
    claim.challengeId === scope.challengeId &&
    claim.occupancyEventId === scope.occupancyEventId &&
    claim.actor.id === scope.actorId
  );
}

/**
 * A bounded materializer for one occupied seat and one actor address.
 *
 * Claims are keyed by durable event ID. Conflicting variants of the same ID
 * converge on their deterministic newest representation, and only the newest
 * bounded window is retained. Thus replay order cannot change the winner.
 */
export class RuntimeSessionElection {
  private readonly claimsByEventId = new Map<string, SessionClaimV1>();
  private readonly maxClaims: number;
  private readonly electionScope: SessionElectionScope;

  public constructor(
    scope: SessionElectionScope,
    options: RuntimeSessionElectionOptions = {},
  ) {
    if (
      !isBoundedString(scope.challengeId, 256) ||
      !isBoundedString(scope.occupancyEventId, 256) ||
      !isBoundedString(scope.actorId, 256)
    ) {
      throw new TypeError("Runtime session election scope contains an invalid identifier");
    }
    const maxClaims = options.maxClaims ?? DEFAULT_RETAINED_SESSION_CLAIMS;
    if (
      !Number.isSafeInteger(maxClaims) ||
      maxClaims < 1 ||
      maxClaims > MAX_RETAINED_SESSION_CLAIMS
    ) {
      throw new RangeError(
        `Runtime session election capacity must be between 1 and ${MAX_RETAINED_SESSION_CLAIMS}`,
      );
    }
    this.maxClaims = maxClaims;
    this.electionScope = { ...scope };
  }

  public get retainedClaimCount(): number {
    return this.claimsByEventId.size;
  }

  /**
   * Applies one payload observed through the durable listener. Returns true
   * only when the retained materialized state changed.
   */
  public apply(value: unknown): boolean {
    if (!isSessionClaim(value) || !scopeMatches(value, this.electionScope)) return false;
    const candidate = cloneClaim(value);
    const existing = this.claimsByEventId.get(candidate.eventId);
    if (existing !== undefined) {
      if (claimFingerprint(existing) === claimFingerprint(candidate)) return false;
      if (compareSessionClaimNewness(candidate, existing) <= 0) return false;
    }

    this.claimsByEventId.set(candidate.eventId, candidate);
    if (this.claimsByEventId.size > this.maxClaims) {
      const oldest = [...this.claimsByEventId.values()].sort(
        compareSessionClaimNewness,
      )[0];
      if (oldest !== undefined) this.claimsByEventId.delete(oldest.eventId);
    }
    return this.claimsByEventId.get(candidate.eventId) === candidate;
  }

  /** Returns a defensive copy of the newest confirmed durable claim. */
  public winner(): SessionClaimV1 | undefined {
    let winner: SessionClaimV1 | undefined;
    for (const claim of this.claimsByEventId.values()) {
      if (winner === undefined || compareSessionClaimNewness(claim, winner) > 0) {
        winner = claim;
      }
    }
    return winner === undefined ? undefined : cloneClaim(winner);
  }

  /** Informational shortcut; control should use `isLocalClaimConfirmed`. */
  public isWinningRuntime(runtimeSessionId: string): boolean {
    return (
      isBoundedString(runtimeSessionId, 128) &&
      this.winner()?.runtimeSessionId === runtimeSessionId
    );
  }

  /**
   * True only when this exact local claim was echoed durably and is the winner.
   * A newly generated runtime must not control the seat before this turns true.
   */
  public isLocalClaimConfirmed(localClaim: SessionClaimV1): boolean {
    if (!isSessionClaim(localClaim) || !scopeMatches(localClaim, this.electionScope)) {
      return false;
    }
    const retained = this.claimsByEventId.get(localClaim.eventId);
    if (retained === undefined || claimFingerprint(retained) !== claimFingerprint(localClaim)) {
      return false;
    }
    const winner = this.winner();
    return (
      winner !== undefined &&
      winner.eventId === localClaim.eventId &&
      claimFingerprint(winner) === claimFingerprint(localClaim)
    );
  }
}
