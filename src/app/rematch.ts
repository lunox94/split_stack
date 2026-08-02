import type { LobbyActor, MaterializedChallenge } from "../network/webxdc-durable";

export interface RematchProposalV1 {
  schema: "split-stack/rematch/v1";
  eventId: string;
  logicalClock: number;
  challengeId: string;
  round: number;
  actor: LobbyActor;
}

function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Materializes only consecutive rematches proposed by an occupied seat. */
export function materializeRematchRound(
  challenge: MaterializedChallenge,
  proposals: readonly RematchProposalV1[],
): number {
  const eligiblePlayers = new Set([
    challenge.seatA.playerId,
    ...(challenge.seatB === null ? [] : [challenge.seatB.playerId]),
  ]);
  const seen = new Set<string>();
  const ordered = proposals
    .filter((proposal) => {
      if (
        proposal.challengeId !== challenge.challengeId ||
        !eligiblePlayers.has(proposal.actor.id) ||
        seen.has(proposal.eventId)
      ) {
        return false;
      }
      seen.add(proposal.eventId);
      return true;
    })
    .sort(
      (left, right) =>
        left.logicalClock - right.logicalClock ||
        compareCodeUnits(left.actor.id, right.actor.id) ||
        compareCodeUnits(left.eventId, right.eventId),
    );
  let round = 1;
  for (const proposal of ordered) {
    if (proposal.round === round + 1) round = proposal.round;
  }
  return round;
}
