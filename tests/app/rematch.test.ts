import { describe, expect, it } from "vitest";
import type { MaterializedChallenge } from "../../src/network/webxdc-durable";
import { materializeRematchRound, type RematchProposalV1 } from "../../src/app/rematch";

const challenge: MaterializedChallenge = {
  challengeId: "challenge-1",
  rulesHash: "rules",
  coordinatorPlayerId: "a",
  seatA: { playerId: "a", displayName: "A", occupancyEventId: "a-session" },
  seatB: { playerId: "b", displayName: "B", occupancyEventId: "b-session" },
  currentSeatBVacancyId: "vacancy",
  closed: false,
};

function proposal(
  eventId: string,
  actorId: string,
  round: number,
  logicalClock: number,
): RematchProposalV1 {
  return {
    schema: "split-stack/rematch/v1",
    eventId,
    logicalClock,
    challengeId: challenge.challengeId,
    round,
    actor: { id: actorId, displayName: actorId.toUpperCase() },
  };
}

describe("rematch materialization", () => {
  it("accepts consecutive proposals from either seated player", () => {
    expect(
      materializeRematchRound(challenge, [
        proposal("round-3", "b", 3, 3),
        proposal("round-2", "a", 2, 2),
      ]),
    ).toBe(3);
  });

  it("ignores spectators, foreign challenges, and round jumps", () => {
    const foreign = { ...proposal("foreign", "a", 2, 1), challengeId: "other" };
    expect(
      materializeRematchRound(challenge, [
        proposal("spectator", "c", 2, 1),
        proposal("jump", "a", 9, 2),
        foreign,
      ]),
    ).toBe(1);
  });

  it("deduplicates competing proposals for the same round", () => {
    expect(
      materializeRematchRound(challenge, [
        proposal("b-proposal", "b", 2, 1),
        proposal("a-proposal", "a", 2, 1),
        proposal("round-3", "b", 3, 2),
      ]),
    ).toBe(3);
  });
});
