import { RULES } from "../config/rules";
import { hashCanonicalHex } from "../domain/hashing";
import type { PlayerResultStats } from "../domain/types";
import { MAX_DURABLE_LOGICAL_CLOCK } from "../network/webxdc-durable";
import type {
  CompetitionActor,
  LiveMatchView,
  MatchFinishedV2,
} from "./competition-ledger-v2";

export interface LiveControllerRecoveryInput {
  readonly observedAtMs: number;
  readonly controllerSeenAtMs: readonly [number | null, number | null];
  readonly nowMs: number;
}

export type LiveControllerRecoveryStatus =
  | { readonly kind: "active-elsewhere" }
  | { readonly kind: "interrupted"; readonly remainingSeconds: number }
  | { readonly kind: "expired" };

function assertTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative`);
  }
  return value;
}

/**
 * Classifies a receive-only replacement runtime without making its presence
 * authoritative. Only traffic from the two already committed controllers
 * enters this calculation; observers never do.
 */
export function liveControllerRecoveryStatus(
  input: LiveControllerRecoveryInput,
): LiveControllerRecoveryStatus {
  const observedAtMs = assertTimestamp(input.observedAtMs, "Observed time");
  const nowMs = assertTimestamp(input.nowMs, "Current time");
  const controllerReferences = input.controllerSeenAtMs.flatMap((seenAtMs) =>
    seenAtMs === null
      ? []
      : [assertTimestamp(seenAtMs, "Controller traffic time")]
  );
  // Any committed controller still producing match traffic proves that the
  // match is active elsewhere. The surviving controller owns peer-loss
  // resolution; a receive-only replacement only offers manual orphan cleanup
  // after it observes no committed controller at all for the full grace.
  const referenceMs = controllerReferences.length === 0
    ? observedAtMs
    : Math.max(...controllerReferences);
  const silenceMs = Math.max(0, nowMs - referenceMs);
  if (silenceMs < RULES.network.missingPeerMs) {
    return { kind: "active-elsewhere" };
  }
  if (silenceMs >= RULES.network.reconnectGraceMs) {
    return { kind: "expired" };
  }
  return {
    kind: "interrupted",
    remainingSeconds: Math.max(
      1,
      Math.ceil((RULES.network.reconnectGraceMs - silenceMs) / 1_000),
    ),
  };
}

function emptyStats(): PlayerResultStats {
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

/**
 * Produces the same neutral result on every replacement runtime. The event ID
 * is stable per participant and committed start, so retries and repeated app
 * launches cannot create another lifecycle intent for that participant.
 */
export function connectionLossFallbackFor(
  match: LiveMatchView,
  actor: CompetitionActor,
): MatchFinishedV2 {
  if (actor.id !== match.seatA.id && actor.id !== match.seatB.id) {
    throw new TypeError("Only a committed match participant may resolve it");
  }
  const participant = actor.id === match.seatA.id ? match.seatA : match.seatB;
  const eventId = `connection-lost:${hashCanonicalHex({
    startedEventId: match.startedEventId,
    actorId: actor.id,
  })}`;
  return {
    schema: "split-stack/competition/v2",
    kind: "match-finished",
    eventId,
    logicalClock: Math.min(
      MAX_DURABLE_LOGICAL_CLOCK,
      match.start.logicalClock + 1,
    ),
    actor: { ...participant },
    matchId: match.matchId,
    startedEventId: match.startedEventId,
    result: {
      schema: "split-stack/result/v1",
      matchId: match.matchId,
      seedHash: match.start.seedHash,
      players: [{ ...match.seatA }, { ...match.seatB }],
      outcome: "desync",
      reason: "connection-lost",
      durationTicks: 0,
      finalLevel: 1,
      statsByPlayer: {
        [match.seatA.id]: emptyStats(),
        [match.seatB.id]: emptyStats(),
      },
      // Keep the result variant identical whichever participant materializes
      // the fallback. Authorization belongs to the enclosing durable event.
      completedBy: match.seatA.id,
    },
  };
}
