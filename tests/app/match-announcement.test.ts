import { describe, expect, it } from "vitest";
import { RULES_HASH } from "../../src/config/rules-hash";
import { competitiveConfigHash } from "../../src/match/competitive-session";
import type { MatchResultV1 } from "../../src/domain/types";
import {
  announcementMatchesChallenge,
  isMatchAnnouncementV1,
  resultMatchesAnnouncement,
  type MatchAnnouncementV1,
} from "../../src/app/match-announcement";
import { hashCanonicalHex } from "../../src/domain/hashing";
import type { MaterializedChallenge } from "../../src/network/webxdc-durable";

const seed = "00112233445566778899aabbccddeeff";

function announcement(): MatchAnnouncementV1 {
  return {
    schema: "split-stack/match-announcement/v1",
    eventId: "announce-1",
    logicalClock: 4,
    challengeId: "challenge-1",
    matchId: "challenge-1:round:1",
    round: 1,
    rulesHash: RULES_HASH,
    configHash: competitiveConfigHash(RULES_HASH, seed, "alice", "bob"),
    seed,
    seedHash: hashCanonicalHex({ seed }),
    seatAPlayerId: "alice",
    seatBPlayerId: "bob",
    actor: { id: "alice", displayName: "Alice" },
  };
}

function result(): MatchResultV1 {
  return {
    schema: "split-stack/result/v1",
    matchId: "challenge-1:round:1",
    seedHash: hashCanonicalHex({ seed }),
    players: [
      { id: "alice", displayName: "Alice" },
      { id: "bob", displayName: "Bob" },
    ],
    outcome: "seat-a",
    reason: "top-out",
    durationTicks: 60,
    finalLevel: 1,
    statsByPlayer: {
      alice: { score: 1, lines: 0, garbageSent: 0, powersActivated: 0, tetrises: 0, tSpinSingles: 0, tSpinDoubles: 0, tSpinTriples: 0 },
      bob: { score: 0, lines: 0, garbageSent: 0, powersActivated: 0, tetrises: 0, tSpinSingles: 0, tSpinDoubles: 0, tSpinTriples: 0, topOutTick: 60 },
    },
    completedBy: "alice",
  };
}

describe("durable match announcements", () => {
  it("authorizes an announcement against the materialized challenge roster", () => {
    const challenge: MaterializedChallenge = {
      challengeId: "challenge-1",
      rulesHash: RULES_HASH,
      coordinatorPlayerId: "alice",
      seatA: { playerId: "alice", displayName: "Alice", occupancyEventId: "created" },
      seatB: { playerId: "bob", displayName: "Bob", occupancyEventId: "claimed" },
      currentSeatBVacancyId: "vacancy-1",
      closed: false,
    };

    expect(announcementMatchesChallenge(announcement(), challenge)).toBe(true);
    expect(
      announcementMatchesChallenge(announcement(), {
        ...challenge,
        seatB: { ...challenge.seatB!, playerId: "mallory" },
      }),
    ).toBe(false);
    expect(announcementMatchesChallenge(announcement(), { ...challenge, seatB: null })).toBe(false);
  });

  it("authenticates the deterministic config, coordinator, seats, and round", () => {
    expect(isMatchAnnouncementV1(announcement(), RULES_HASH)).toBe(true);
    expect(isMatchAnnouncementV1({ ...announcement(), seatBPlayerId: "mallory" }, RULES_HASH)).toBe(false);
    expect(isMatchAnnouncementV1({ ...announcement(), actor: { id: "bob", displayName: "Bob" } }, RULES_HASH)).toBe(false);
    expect(isMatchAnnouncementV1({ ...announcement(), matchId: "other" }, RULES_HASH)).toBe(false);
  });

  it("accepts history only when it belongs to a known announced config", () => {
    expect(resultMatchesAnnouncement(result(), announcement())).toBe(true);
    expect(resultMatchesAnnouncement({ ...result(), seedHash: "forged" }, announcement())).toBe(false);
    const swapped = result();
    swapped.players = [swapped.players[1]!, swapped.players[0]!];
    expect(resultMatchesAnnouncement(swapped, announcement())).toBe(false);
  });
});
