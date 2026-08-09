import { describe, expect, it } from "vitest";

import { RULES } from "../../src/config/rules";
import { hashCanonicalHex } from "../../src/domain/hashing";
import type { MatchResult } from "../../src/domain/types";
import {
  CompetitionLedger,
  type ChallengeCreated,
  type ChallengeClaimed,
  type ChallengeCancelled,
  type PairingLeft,
  type RuntimeClaimed,
  type ReadyChanged,
  type MatchStarted,
  type MatchFinished,
  type MatchConceded,
  type RematchRequested,
  type RematchAccepted,
  type PracticeCompleted,
  type RematchWithdrawn,
  isCompetitionEvent,
} from "../../src/app/competition-ledger";

const RULES_HASH = "rules-current";

function created(
  actorId: string,
  challengeId: string,
  logicalClock: number,
): ChallengeCreated {
  return {
    schema: "split-stack/competition/v2",
    kind: "challenge-created",
    eventId: `${challengeId}:created`,
    logicalClock,
    actor: { id: actorId, displayName: actorId.toUpperCase() },
    challengeId,
    rulesHash: RULES_HASH,
    vacancyId: `${challengeId}:vacancy:1`,
  };
}

function claimed(
  actorId: string,
  challengeId: string,
  vacancyId: string,
  logicalClock: number,
): ChallengeClaimed {
  return {
    schema: "split-stack/competition/v2",
    kind: "challenge-claimed",
    eventId: `${challengeId}:claimed:${actorId}`,
    logicalClock,
    actor: { id: actorId, displayName: actorId.toUpperCase() },
    challengeId,
    vacancyId,
  };
}

function pairingLeft(
  actorId: string,
  pairingId: string,
  runtimeSessionId: string,
  logicalClock: number,
): PairingLeft {
  return {
    schema: "split-stack/competition/v2",
    kind: "pairing-left",
    eventId: `${pairingId}:left:${actorId}:${runtimeSessionId}`,
    logicalClock,
    actor: { id: actorId, displayName: actorId.toUpperCase() },
    pairingId,
    runtimeSessionId,
  };
}

function cancelled(
  actorId: string,
  challengeId: string,
  logicalClock: number,
): ChallengeCancelled {
  return {
    schema: "split-stack/competition/v2",
    kind: "challenge-cancelled",
    eventId: `${challengeId}:cancelled:${actorId}`,
    logicalClock,
    actor: { id: actorId, displayName: actorId.toUpperCase() },
    challengeId,
  };
}

function runtimeClaimed(
  actorId: string,
  pairingId: string,
  runtimeSessionId: string,
  logicalClock: number,
): RuntimeClaimed {
  return {
    schema: "split-stack/competition/v2",
    kind: "runtime-claimed",
    eventId: `${pairingId}:runtime:${actorId}:${runtimeSessionId}`,
    logicalClock,
    actor: { id: actorId, displayName: actorId.toUpperCase() },
    pairingId,
    runtimeSessionId,
  };
}

function readyChanged(
  actorId: string,
  pairingId: string,
  runtimeSessionId: string,
  ready: boolean,
  logicalClock: number,
): ReadyChanged {
  return {
    schema: "split-stack/competition/v2",
    kind: "ready-changed",
    eventId: `${pairingId}:ready:${actorId}:${logicalClock}`,
    logicalClock,
    actor: { id: actorId, displayName: actorId.toUpperCase() },
    pairingId,
    runtimeSessionId,
    ready,
  };
}

const MATCH_SEED = "00112233445566778899aabbccddeeff";

function started(
  pairingId: string,
  seriesId: string,
  round: number,
  logicalClock: number,
  seed = MATCH_SEED,
): MatchStarted {
  const seatAPlayerId = "alice";
  const seatBPlayerId = "bob";
  return {
    schema: "split-stack/competition/v2",
    kind: "match-started",
    eventId: `${seriesId}:started:${round}`,
    logicalClock,
    actor: { id: seatAPlayerId, displayName: "ALICE" },
    pairingId,
    seriesId,
    round,
    matchId: `${seriesId}:round:${round}`,
    rulesHash: RULES_HASH,
    configHash: hashCanonicalHex({
      rulesVersion: RULES.rulesVersion,
      rulesHash: RULES_HASH,
      seed,
      seatAPlayerId,
      seatBPlayerId,
    }),
    seed,
    seedHash: hashCanonicalHex({ seed }),
    seatAPlayerId,
    seatBPlayerId,
    seatASessionId: "runtime-a",
    seatBSessionId: "runtime-b",
  };
}

function startedForPlayers(
  pairingId: string,
  seriesId: string,
  logicalClock: number,
  seatAPlayerId: string,
  seatBPlayerId: string,
  seed: string,
): MatchStarted {
  return {
    schema: "split-stack/competition/v2",
    kind: "match-started",
    eventId: `${seriesId}:started:1`,
    logicalClock,
    actor: { id: seatAPlayerId, displayName: seatAPlayerId.toUpperCase() },
    pairingId,
    seriesId,
    round: 1,
    matchId: `${seriesId}:round:1`,
    rulesHash: RULES_HASH,
    configHash: hashCanonicalHex({
      rulesVersion: RULES.rulesVersion,
      rulesHash: RULES_HASH,
      seed,
      seatAPlayerId,
      seatBPlayerId,
    }),
    seed,
    seedHash: hashCanonicalHex({ seed }),
    seatAPlayerId,
    seatBPlayerId,
    seatASessionId: `runtime:${seatAPlayerId}`,
    seatBSessionId: `runtime:${seatBPlayerId}`,
  };
}

function result(
  matchId: string,
  outcome: MatchResult["outcome"],
  seed = MATCH_SEED,
): MatchResult {
  const stats = (score: number) => ({
    score,
    lines: 2,
    garbageSent: 1,
    powersActivated: 0,
    tetrises: 0,
    tSpinSingles: 0,
    tSpinDoubles: 0,
    tSpinTriples: 0,
  });
  return {
    schema: "split-stack/result/v1",
    matchId,
    seedHash: hashCanonicalHex({ seed }),
    players: [
      { id: "alice", displayName: "ALICE" },
      { id: "bob", displayName: "BOB" },
    ],
    outcome,
    reason: outcome === "draw" ? "simultaneous" : outcome === "desync" ? "connection-lost" : "top-out",
    durationTicks: 600,
    finalLevel: 2,
    statsByPlayer: { alice: stats(900), bob: stats(700) },
    completedBy: "alice",
  };
}

function finished(start: MatchStarted, outcome: MatchResult["outcome"], logicalClock: number): MatchFinished {
  return {
    schema: "split-stack/competition/v2",
    kind: "match-finished",
    eventId: `${start.matchId}:finished:${logicalClock}`,
    logicalClock,
    actor: { id: "alice", displayName: "ALICE" },
    matchId: start.matchId,
    startedEventId: start.eventId,
    result: result(start.matchId, outcome, start.seed),
  };
}

function conceded(
  start: MatchStarted,
  actorId: "alice" | "bob",
  logicalClock: number,
): MatchConceded {
  return {
    schema: "split-stack/competition/v2",
    kind: "match-conceded",
    eventId: `${start.matchId}:conceded:${actorId}`,
    logicalClock,
    actor: { id: actorId, displayName: actorId.toUpperCase() },
    matchId: start.matchId,
    startedEventId: start.eventId,
  };
}

function rematchRequested(
  actorId: string,
  seriesId: string,
  afterMatchId: string,
  round: number,
  logicalClock: number,
): RematchRequested {
  return {
    schema: "split-stack/competition/v2",
    kind: "rematch-requested",
    eventId: `${seriesId}:rematch:${round}:${actorId}`,
    logicalClock,
    actor: { id: actorId, displayName: actorId.toUpperCase() },
    seriesId,
    afterMatchId,
    round,
  };
}

function rematchAccepted(
  actorId: string,
  request: RematchRequested,
  logicalClock: number,
): RematchAccepted {
  return {
    schema: "split-stack/competition/v2",
    kind: "rematch-accepted",
    eventId: `${request.seriesId}:rematch:${request.round}:accepted:${actorId}`,
    logicalClock,
    actor: { id: actorId, displayName: actorId.toUpperCase() },
    seriesId: request.seriesId,
    afterMatchId: request.afterMatchId,
    round: request.round,
    requestedEventId: request.eventId,
  };
}

function practiceCompleted(
  actorId: string,
  score: number,
  logicalClock: number,
  rulesHash = RULES_HASH,
): PracticeCompleted {
  return {
    schema: "split-stack/competition/v2",
    kind: "practice-completed",
    eventId: `practice:${actorId}:${logicalClock}`,
    logicalClock,
    actor: { id: actorId, displayName: actorId.toUpperCase() },
    rulesHash,
    runId: `run:${actorId}:${logicalClock}`,
    endReason: "top-out",
    score,
    durationTicks: 600,
    finalLevel: 2,
    finalStats: {
      score,
      lines: 4,
      garbageSent: 0,
      powersActivated: 0,
      tetrises: 1,
      tSpinSingles: 0,
      tSpinDoubles: 0,
      tSpinTriples: 0,
      topOutTick: 600,
    },
  };
}

function rematchWithdrawn(
  actorId: string,
  seriesId: string,
  round: number,
  logicalClock: number,
): RematchWithdrawn {
  return {
    schema: "split-stack/competition/v2",
    kind: "rematch-withdrawn",
    eventId: `${seriesId}:rematch:${round}:withdrawn:${actorId}`,
    logicalClock,
    actor: { id: actorId, displayName: actorId.toUpperCase() },
    seriesId,
    round,
  };
}

function appendCompletedMatch(
  ledger: CompetitionLedger,
  seriesId: string,
  firstClock: number,
  outcome: MatchResult["outcome"],
): MatchStarted {
  const challenge = created("alice", seriesId, firstClock);
  const claim = claimed("bob", seriesId, challenge.vacancyId, firstClock + 1);
  const start = started(claim.eventId, seriesId, 1, firstClock + 6);
  const events = [
    challenge,
    claim,
    runtimeClaimed("alice", claim.eventId, "runtime-a", firstClock + 2),
    runtimeClaimed("bob", claim.eventId, "runtime-b", firstClock + 3),
    readyChanged("alice", claim.eventId, "runtime-a", true, firstClock + 4),
    readyChanged("bob", claim.eventId, "runtime-b", true, firstClock + 5),
    start,
    finished(start, outcome, firstClock + 7),
  ];
  events.forEach((payload, offset) => {
    ledger.apply({ serial: firstClock + offset, payload });
  });
  return start;
}

describe("CompetitionLedger", () => {
  it("materializes one waiting commitment per player in canonical event order", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });

    ledger.apply({ serial: 2, payload: created("alice", "later", 2) });
    ledger.apply({ serial: 1, payload: created("alice", "first", 1) });

    expect(ledger.view("alice")).toMatchObject({
      counts: { waiting: 1, starting: 0, live: 0, completed: 0 },
      activity: { kind: "waiting", challengeId: "first" },
      openChallenges: [{ challengeId: "first", creator: { id: "alice" } }],
    });
  });

  it("materializes four disjoint live pairs concurrently without a global match cap", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const pairs = Array.from({ length: 4 }, (_, index) => ({
      seriesId: `series-${index + 1}`,
      seatA: `player-${index * 2 + 1}`,
      seatB: `player-${index * 2 + 2}`,
    }));
    let logicalClock = 0;
    let serial = 0;
    const apply = (payload: Parameters<CompetitionLedger["apply"]>[0]["payload"]): void => {
      ledger.apply({ serial: ++serial, payload });
    };
    const challenges = pairs.map((pair) => {
      const challenge = created(pair.seatA, pair.seriesId, ++logicalClock);
      apply(challenge);
      return challenge;
    });
    const claims = pairs.map((pair, index) => {
      const challenge = challenges[index]!;
      const claim = claimed(
        pair.seatB,
        challenge.challengeId,
        challenge.vacancyId,
        ++logicalClock,
      );
      apply(claim);
      return claim;
    });
    pairs.forEach((pair, index) => {
      const pairingId = claims[index]!.eventId;
      apply(runtimeClaimed(
        pair.seatA,
        pairingId,
        `runtime:${pair.seatA}`,
        ++logicalClock,
      ));
      apply(runtimeClaimed(
        pair.seatB,
        pairingId,
        `runtime:${pair.seatB}`,
        ++logicalClock,
      ));
      apply(readyChanged(
        pair.seatA,
        pairingId,
        `runtime:${pair.seatA}`,
        true,
        ++logicalClock,
      ));
      apply(readyChanged(
        pair.seatB,
        pairingId,
        `runtime:${pair.seatB}`,
        true,
        ++logicalClock,
      ));
    });
    pairs.forEach((pair, index) => {
      const seed = (index + 1).toString(16).padStart(32, "0");
      apply(startedForPlayers(
        claims[index]!.eventId,
        pair.seriesId,
        ++logicalClock,
        pair.seatA,
        pair.seatB,
        seed,
      ));
    });

    const view = ledger.view();
    expect(view.counts).toEqual({ waiting: 0, starting: 0, live: 4, completed: 0 });
    expect(view.liveMatches).toHaveLength(4);
    expect(view.liveMatches.map((match) => match.seriesId)).toEqual(
      pairs.map((pair) => pair.seriesId),
    );
    for (const pair of pairs) {
      expect(ledger.view(pair.seatA).activity).toMatchObject({
        kind: "live",
        seriesId: pair.seriesId,
      });
      expect(ledger.view(pair.seatB).activity).toMatchObject({
        kind: "live",
        seriesId: pair.seriesId,
      });
    }
  });

  it("gives a vacancy to the first canonical eligible claimant", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "challenge", 1);

    ledger.apply({
      serial: 3,
      payload: claimed("charlie", challenge.challengeId, challenge.vacancyId, 2),
    });
    ledger.apply({ serial: 1, payload: challenge });
    ledger.apply({
      serial: 2,
      payload: claimed("bob", challenge.challengeId, challenge.vacancyId, 2),
    });

    expect(ledger.view("bob")).toMatchObject({
      counts: { waiting: 0, starting: 1, live: 0, completed: 0 },
      activity: {
        kind: "starting",
        pairingId: "challenge:claimed:bob",
        matchId: "challenge:round:1",
      },
      startingPairings: [{
        pairingId: "challenge:claimed:bob",
        source: "challenge",
        seatA: { id: "alice" },
        seatB: { id: "bob" },
      }],
    });
    expect(ledger.view("charlie").activity).toEqual({ kind: "idle" });
    expect(ledger.view("charlie").rejectedClaims).toEqual([expect.objectContaining({
      claimEventId: "challenge:claimed:charlie",
      reason: "vacancy-claimed",
      winningPairingId: "challenge:claimed:bob",
    })]);
  });

  it("explains every structurally valid rejected claim to its claimant", () => {
    const rejection = (
      events: readonly (ChallengeCreated | ChallengeClaimed)[],
      playerId: string,
    ) => {
      const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
      events.forEach((payload, index) => ledger.apply({ serial: index + 1, payload }));
      return ledger.view(playerId).rejectedClaims[0];
    };
    const selfChallenge = created("alice", "self", 1);
    const staleChallenge = created("alice", "stale", 1);
    const target = created("alice", "target", 1);
    const bobCommitment = created("bob", "bob-waits", 2);

    expect(rejection([
      claimed("bob", "missing", "missing:vacancy", 1),
    ], "bob")?.reason).toBe("challenge-unavailable");
    expect(rejection([
      selfChallenge,
      claimed("alice", selfChallenge.challengeId, selfChallenge.vacancyId, 2),
    ], "alice")?.reason).toBe("self-join");
    expect(rejection([
      staleChallenge,
      claimed("bob", staleChallenge.challengeId, "old-vacancy", 2),
    ], "bob")?.reason).toBe("stale-vacancy");
    expect(rejection([
      target,
      bobCommitment,
      claimed("bob", target.challengeId, target.vacancyId, 3),
    ], "bob")?.reason).toBe("already-committed");
  });

  it("allows one player to win only one claim across different challenges", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const alice = created("alice", "alice-series", 1);
    const charlie = created("charlie", "charlie-series", 1);
    const records = [
      { serial: 1, payload: alice },
      { serial: 2, payload: charlie },
      {
        serial: 3,
        payload: claimed("bob", alice.challengeId, alice.vacancyId, 2),
      },
      {
        serial: 4,
        payload: claimed("bob", charlie.challengeId, charlie.vacancyId, 3),
      },
    ];
    records.reverse().forEach((record) => ledger.apply(record));

    expect(ledger.view("bob").activity).toMatchObject({
      kind: "starting",
      matchId: "alice-series:round:1",
    });
    expect(ledger.view().openChallenges.map((challenge) => challenge.challengeId))
      .toEqual(["charlie-series"]);
  });

  it("reopens a challenge with a fresh vacancy when its joiner leaves", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "challenge", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const runtime = runtimeClaimed("bob", claim.eventId, "runtime-b", 3);
    const left = pairingLeft("bob", claim.eventId, runtime.runtimeSessionId, 4);

    ledger.apply({ serial: 1, payload: challenge });
    ledger.apply({ serial: 2, payload: claim });
    ledger.apply({ serial: 3, payload: runtime });
    ledger.apply({ serial: 4, payload: left });
    ledger.apply({
      serial: 5,
      payload: claimed("charlie", challenge.challengeId, challenge.vacancyId, 5),
    });

    expect(ledger.view("alice")).toMatchObject({
      counts: { waiting: 1, starting: 0 },
      activity: { kind: "waiting", challengeId: "challenge" },
      openChallenges: [{
        challengeId: "challenge",
        vacancyId: `${left.eventId}:vacancy`,
      }],
    });
    expect(ledger.view("bob").activity).toEqual({ kind: "idle" });
  });

  it("ignores a pre-start exit from a superseded runtime binding", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "guarded-pairing", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const events = [
      challenge,
      claim,
      runtimeClaimed("bob", claim.eventId, "runtime-b-old", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b-current", 4),
      pairingLeft("bob", claim.eventId, "runtime-b-old", 5),
    ];
    events.forEach((payload, index) => ledger.apply({ serial: index + 1, payload }));

    expect(ledger.view("bob")).toMatchObject({
      counts: { waiting: 0, starting: 1 },
      activity: { kind: "starting", pairingId: claim.eventId },
      startingPairings: [{
        pairingId: claim.eventId,
        runtimeSessionByPlayer: { bob: "runtime-b-current" },
      }],
    });

    const currentExit = pairingLeft("bob", claim.eventId, "runtime-b-current", 6);
    ledger.apply({ serial: 6, payload: currentExit });

    expect(ledger.view("bob")).toMatchObject({
      counts: { waiting: 1, starting: 0 },
      activity: { kind: "idle" },
    });
  });

  it("rejects a deferred pairing exit when a later cancellation removes its target", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "cancelled-before-runtime", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const left = pairingLeft("bob", claim.eventId, "runtime-b", 3);
    ledger.apply({ serial: 1, payload: challenge });
    ledger.apply({ serial: 2, payload: claim });
    ledger.apply({ serial: 3, payload: left });
    expect(ledger.eventStatus(left.eventId)).toBe("deferred");

    ledger.apply({
      serial: 4,
      payload: cancelled("alice", challenge.challengeId, 4),
    });

    expect(ledger.eventStatus(left.eventId)).toBe("rejected");
    expect(ledger.view("bob").activity).toEqual({ kind: "idle" });
  });

  it("lets only the creator cancel a waiting or starting challenge", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "challenge", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const forgedCancellation = cancelled("mallory", challenge.challengeId, 3);
    const creatorCancellation = cancelled("alice", challenge.challengeId, 4);

    ledger.apply({ serial: 1, payload: challenge });
    ledger.apply({ serial: 2, payload: claim });
    ledger.apply({ serial: 3, payload: forgedCancellation });
    ledger.apply({ serial: 4, payload: creatorCancellation });

    expect(ledger.view("alice")).toMatchObject({
      counts: { waiting: 0, starting: 0 },
      activity: { kind: "idle" },
    });
    expect(ledger.view("bob").activity).toEqual({ kind: "idle" });
    expect(ledger.eventStatus(forgedCancellation.eventId)).toBe("rejected");
    expect(ledger.eventStatus(creatorCancellation.eventId)).toBe("effective");
  });

  it("commits and finishes an elected match, then aggregates its official result", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "series", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const start = started(claim.eventId, challenge.challengeId, 1, 7);
    const events = [
      challenge,
      claim,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b", 4),
      readyChanged("alice", claim.eventId, "runtime-a", true, 5),
      readyChanged("bob", claim.eventId, "runtime-b", true, 6),
      start,
      finished(start, "seat-a", 8),
    ];
    events.forEach((payload, index) => ledger.apply({ serial: index + 1, payload }));

    expect(ledger.view("alice")).toMatchObject({
      counts: { waiting: 0, starting: 0, live: 0, completed: 1 },
      activity: { kind: "idle" },
      recentResults: [{
        matchId: "series:round:1",
        seriesId: "series",
        round: 1,
        result: { outcome: "seat-a" },
      }],
      standings: [
        { player: { id: "alice" }, wins: 1, losses: 0, draws: 0, winRate: 1 },
        { player: { id: "bob" }, wins: 0, losses: 1, draws: 0, winRate: 0 },
      ],
      headToHead: [{
        playerIds: ["alice", "bob"],
        winsByPlayer: { alice: 1, bob: 0 },
        draws: 0,
      }],
    });
  });

  it("requires both players' requests before creating exactly one rematch pairing", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "series", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const start = started(claim.eventId, challenge.challengeId, 1, 7);
    const baseEvents = [
      challenge,
      claim,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b", 4),
      readyChanged("alice", claim.eventId, "runtime-a", true, 5),
      readyChanged("bob", claim.eventId, "runtime-b", true, 6),
      start,
      finished(start, "seat-a", 8),
    ];
    baseEvents.forEach((payload, index) => ledger.apply({ serial: index + 1, payload }));
    const aliceRequest = rematchRequested("alice", "series", start.matchId, 2, 9);
    const bobRequest = rematchRequested("bob", "series", start.matchId, 2, 10);

    ledger.apply({ serial: 9, payload: bobRequest });
    expect(ledger.view("bob")).toMatchObject({
      activity: { kind: "idle" },
      counts: { starting: 0 },
      pendingRematches: [{ requestedByPlayerIds: ["bob"] }],
    });
    ledger.apply({ serial: 10, payload: aliceRequest });
    expect(ledger.view("alice")).toMatchObject({
      activity: {
        kind: "starting",
        pairingId: bobRequest.eventId,
        matchId: "series:round:2",
        round: 2,
      },
      counts: { starting: 1, completed: 1 },
      pendingRematches: [],
      startingPairings: [{
        source: "rematch",
        pairingId: bobRequest.eventId,
        seriesId: "series",
        round: 2,
      }],
    });
  });

  it("creates a rematch from one request and the opponent's explicit acceptance", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const first = appendCompletedMatch(ledger, "accepted-series", 1, "seat-a");
    const request = rematchRequested("alice", first.seriesId, first.matchId, 2, 9);
    const acceptance = rematchAccepted("bob", request, 10);

    ledger.apply({ serial: 9, payload: request });
    expect(ledger.view("alice").pendingRematches).toHaveLength(1);
    ledger.apply({ serial: 10, payload: acceptance });

    expect(ledger.view("bob")).toMatchObject({
      activity: {
        kind: "starting",
        pairingId: acceptance.eventId,
        matchId: "accepted-series:round:2",
      },
      pendingRematches: [],
      startingPairings: [{ source: "rematch", pairingId: acceptance.eventId }],
    });
  });

  it("ignores stale, self, and foreign rematch acceptances", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const first = appendCompletedMatch(ledger, "guarded-series", 1, "seat-a");
    const request = rematchRequested("alice", first.seriesId, first.matchId, 2, 9);
    ledger.apply({ serial: 9, payload: request });
    const invalid = [
      rematchAccepted("alice", request, 10),
      { ...rematchAccepted("bob", request, 11), requestedEventId: "stale-request" },
      rematchAccepted("charlie", request, 12),
    ];
    invalid.forEach((payload, index) => ledger.apply({ serial: index + 10, payload }));

    expect(ledger.view()).toMatchObject({
      counts: { starting: 0, completed: 1 },
      pendingRematches: [{ requestedByPlayerIds: ["alice"] }],
    });
  });

  it("requires every accepted round in a series to use a fresh seed", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const first = appendCompletedMatch(ledger, "fresh-seed-series", 1, "seat-a");
    const request = rematchRequested("alice", first.seriesId, first.matchId, 2, 9);
    const acceptance = rematchAccepted("bob", request, 10);
    ledger.apply({ serial: 9, payload: request });
    ledger.apply({ serial: 10, payload: acceptance });
    const setup = [
      runtimeClaimed("alice", acceptance.eventId, "runtime-a", 11),
      runtimeClaimed("bob", acceptance.eventId, "runtime-b", 12),
      readyChanged("alice", acceptance.eventId, "runtime-a", true, 13),
      readyChanged("bob", acceptance.eventId, "runtime-b", true, 14),
    ];
    setup.forEach((payload, index) => ledger.apply({ serial: index + 11, payload }));
    const reused = started(acceptance.eventId, first.seriesId, 2, 15);
    ledger.apply({ serial: 15, payload: reused });
    expect(ledger.view().counts).toMatchObject({ starting: 1, live: 0 });

    const freshSeed = "ffeeddccbbaa99887766554433221100";
    const fresh = {
      ...started(acceptance.eventId, first.seriesId, 2, 16, freshSeed),
      eventId: `${first.seriesId}:started:2:fresh`,
    };
    ledger.apply({ serial: 16, payload: fresh });
    ledger.apply({ serial: 17, payload: finished(fresh, "seat-b", 17) });

    expect(ledger.view()).toMatchObject({
      counts: { live: 0, completed: 2 },
      seriesScores: [{
        seriesId: first.seriesId,
        winsByPlayer: { alice: 1, bob: 1 },
        draws: 0,
        completedRounds: 2,
        latestRound: 2,
      }],
    });
  });

  it("does not resurrect a rematch after either player takes another commitment", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "series", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const start = started(claim.eventId, challenge.challengeId, 1, 7);
    const baseEvents = [
      challenge,
      claim,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b", 4),
      readyChanged("alice", claim.eventId, "runtime-a", true, 5),
      readyChanged("bob", claim.eventId, "runtime-b", true, 6),
      start,
      finished(start, "seat-a", 8),
      rematchRequested("alice", "series", start.matchId, 2, 9),
    ];
    baseEvents.forEach((payload, index) => ledger.apply({ serial: index + 1, payload }));
    const other = created("bob", "other", 10);
    ledger.apply({ serial: 10, payload: other });
    ledger.apply({ serial: 11, payload: cancelled("bob", other.challengeId, 11) });
    ledger.apply({
      serial: 12,
      payload: rematchRequested("bob", "series", start.matchId, 2, 12),
    });

    expect(ledger.view("alice")).toMatchObject({
      counts: { waiting: 0, starting: 0, live: 0, completed: 1 },
      pendingRematches: [],
      activity: { kind: "idle" },
    });
    expect(ledger.view("bob").activity).toEqual({ kind: "idle" });
  });

  it("does not create a late rematch request after an intervening commitment", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "series", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const start = started(claim.eventId, challenge.challengeId, 1, 7);
    const baseEvents = [
      challenge,
      claim,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b", 4),
      readyChanged("alice", claim.eventId, "runtime-a", true, 5),
      readyChanged("bob", claim.eventId, "runtime-b", true, 6),
      start,
      finished(start, "seat-a", 8),
    ];
    baseEvents.forEach((payload, index) => ledger.apply({ serial: index + 1, payload }));

    const other = created("bob", "other", 9);
    ledger.apply({ serial: 9, payload: other });
    ledger.apply({ serial: 10, payload: cancelled("bob", other.challengeId, 10) });
    const lateRequest = rematchRequested("alice", "series", start.matchId, 2, 11);
    ledger.apply({ serial: 11, payload: lateRequest });

    expect(ledger.eventStatus(lateRequest.eventId)).toBe("rejected");
    expect(ledger.view().pendingRematches).toEqual([]);
  });

  it("shows current-rules Practice bests as a top ten with an outside player pinned", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    for (let rank = 1; rank <= 11; rank += 1) {
      const player = `player-${rank.toString().padStart(2, "0")}`;
      ledger.apply({
        serial: rank,
        payload: practiceCompleted(player, 1_200 - rank * 50, rank),
      });
    }
    ledger.apply({
      serial: 12,
      payload: practiceCompleted("player-11", 1, 12),
    });
    ledger.apply({
      serial: 13,
      payload: practiceCompleted("outsider", 99_999, 13, "old-rules"),
    });

    expect(ledger.view("player-11").practice).toMatchObject({
      totalPlayers: 11,
      record: { rank: 1, player: { id: "player-01" }, score: 1_150 },
      personalBest: { rank: 11, player: { id: "player-11" }, score: 650 },
      pinned: { rank: 11, player: { id: "player-11" }, score: 650 },
    });
    const leaderboard = ledger.view("player-11").practice.leaderboard;
    expect(leaderboard).toHaveLength(10);
    expect(leaderboard[0]).toMatchObject({
      rank: 1,
      player: { id: "player-01" },
      score: 1_150,
    });
  });

  it("keeps same-duration Practice games distinct when their run ids differ", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const first = practiceCompleted("alice", 1_000, 1);
    const second = practiceCompleted("alice", 2_000, 2);
    expect(first.durationTicks).toBe(second.durationTicks);

    ledger.apply({ serial: 1, payload: first });
    ledger.apply({ serial: 2, payload: second });

    expect(ledger.view("alice").practice.personalBest).toMatchObject({
      score: 2_000,
      runId: second.runId,
    });
    expect(ledger.isEventEffective(first.eventId)).toBe(true);
    expect(ledger.isEventEffective(second.eventId)).toBe(true);
  });

  it("lets either participant withdraw a pending rematch without reserving a seat", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "series", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const start = started(claim.eventId, challenge.challengeId, 1, 7);
    const events = [
      challenge,
      claim,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b", 4),
      readyChanged("alice", claim.eventId, "runtime-a", true, 5),
      readyChanged("bob", claim.eventId, "runtime-b", true, 6),
      start,
      finished(start, "seat-a", 8),
      rematchRequested("alice", "series", start.matchId, 2, 9),
      rematchWithdrawn("bob", "series", 2, 10),
      rematchRequested("bob", "series", start.matchId, 2, 11),
    ];
    events.forEach((payload, index) => ledger.apply({ serial: index + 1, payload }));

    expect(ledger.view("alice")).toMatchObject({
      activity: { kind: "idle" },
      counts: { starting: 0 },
      pendingRematches: [],
    });
  });

  it("strictly validates every v2 event shape", () => {
    const challenge = created("alice", "series", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const start = started(claim.eventId, challenge.challengeId, 1, 7);
    const request = rematchRequested("alice", "series", start.matchId, 2, 9);
    const left = pairingLeft("bob", claim.eventId, "runtime-b", 3);
    const concession = conceded(start, "alice", 8);
    const valid = [
      challenge,
      claim,
      cancelled("alice", challenge.challengeId, 3),
      left,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      readyChanged("alice", claim.eventId, "runtime-a", true, 4),
      start,
      finished(start, "seat-a", 8),
      concession,
      request,
      rematchAccepted("bob", request, 10),
      rematchWithdrawn("alice", "series", 2, 10),
      practiceCompleted("alice", 1_000, 11),
    ];

    for (const event of valid) {
      expect(isCompetitionEvent(event), event.kind).toBe(true);
      expect(isCompetitionEvent({ ...event, unexpected: true }), event.kind).toBe(false);
    }
    expect(isCompetitionEvent({ ...practiceCompleted("alice", 1_000, 12), score: -1 }))
      .toBe(false);
    const { runtimeSessionId: _runtimeSessionId, ...leftWithoutRuntime } = left;
    expect(isCompetitionEvent(leftWithoutRuntime)).toBe(false);
    expect(isCompetitionEvent({ ...left, runtimeSessionId: "" })).toBe(false);
    expect(isCompetitionEvent({ ...start, configHash: "forged" })).toBe(false);
    const { startedEventId: _startedEventId, ...concessionWithoutStart } = concession;
    expect(isCompetitionEvent(concessionWithoutStart)).toBe(false);
    expect(isCompetitionEvent({ ...finished(start, "seat-a", 13), result: { ...result(start.matchId, "seat-a"), extra: true } }))
      .toBe(false);
  });

  it("orders open challenges oldest first regardless of replay order", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    [
      { serial: 3, payload: created("charlie", "third", 3) },
      { serial: 1, payload: created("alice", "first", 1) },
      { serial: 2, payload: created("bob", "second", 2) },
    ].forEach((record) => ledger.apply(record));

    expect(ledger.view().openChallenges.map((challenge) => challenge.challengeId))
      .toEqual(["first", "second", "third"]);
  });

  it("resets readiness before start and rejects backdated mutations after start", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "series", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const setup = [
      challenge,
      claim,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b", 4),
      readyChanged("alice", claim.eventId, "runtime-a", true, 5),
      readyChanged("bob", claim.eventId, "runtime-b", true, 6),
      runtimeClaimed("alice", claim.eventId, "runtime-a2", 7),
    ];
    setup.forEach((payload, index) => ledger.apply({ serial: index + 1, payload }));

    expect(ledger.view("alice").startingPairings[0]).toMatchObject({
      readyByPlayer: { alice: false, bob: true },
      runtimeSessionByPlayer: { alice: "runtime-a2", bob: "runtime-b" },
    });

    ledger.apply({
      serial: 8,
      payload: readyChanged("alice", claim.eventId, "runtime-a2", true, 8),
    });
    const start = { ...started(claim.eventId, "series", 1, 9), seatASessionId: "runtime-a2" };
    ledger.apply({ serial: 9, payload: start });

    expect(ledger.view("alice")).toMatchObject({
      activity: { kind: "live", matchId: "series:round:1" },
      counts: { starting: 0, live: 1 },
      liveMatches: [{
        matchId: "series:round:1",
        start: {
          seed: MATCH_SEED,
          configHash: start.configHash,
          seatASessionId: "runtime-a2",
          seatBSessionId: "runtime-b",
        },
      }],
    });

    ledger.apply({
      serial: 10,
      payload: runtimeClaimed("alice", claim.eventId, "runtime-after-start", 10),
    });
    ledger.apply({
      serial: 11,
      payload: pairingLeft("alice", claim.eventId, "runtime-a2", 11),
    });
    ledger.apply({
      serial: 12,
      payload: cancelled("alice", challenge.challengeId, 12),
    });
    expect(ledger.view().liveMatches[0]?.runtimeSessionByPlayer.alice).toBe(
      "runtime-a2",
    );
  });

  it("defers a valid start until a later canonical ready event closes the realtime race", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "ready-race", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const start = started(claim.eventId, challenge.challengeId, 1, 6);
    const events = [
      challenge,
      claim,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b", 4),
      readyChanged("alice", claim.eventId, "runtime-a", true, 5),
      start,
      readyChanged("bob", claim.eventId, "runtime-b", true, 7),
    ];

    events
      .map((payload, index) => ({ serial: index + 1, payload }))
      .reverse()
      .forEach((record) => ledger.apply(record));

    expect(ledger.view("alice")).toMatchObject({
      counts: { waiting: 0, starting: 0, live: 1, completed: 0 },
      activity: { kind: "live", matchId: start.matchId },
      liveMatches: [{ matchId: start.matchId, startedEventId: start.eventId }],
    });
  });

  it("retries a finish that arrives while its valid start is still deferred", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "finish-race", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const start = started(claim.eventId, challenge.challengeId, 1, 6);
    const events = [
      challenge,
      claim,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b", 4),
      readyChanged("alice", claim.eventId, "runtime-a", true, 5),
      start,
      finished(start, "seat-a", 7),
      readyChanged("bob", claim.eventId, "runtime-b", true, 8),
    ];
    events.slice(0, 7).forEach((payload, index) => {
      ledger.apply({ serial: index + 1, payload });
    });
    expect(ledger.eventStatus(start.eventId)).toBe("deferred");
    expect(ledger.eventStatus(events[6]!.eventId)).toBe("deferred");
    ledger.apply({ serial: 8, payload: events[7]! });

    expect(ledger.view("alice")).toMatchObject({
      counts: { waiting: 0, starting: 0, live: 0, completed: 1 },
      activity: { kind: "idle" },
      recentResults: [{ matchId: start.matchId, result: { outcome: "seat-a" } }],
    });
    expect(ledger.isEventEffective(start.eventId)).toBe(true);
    expect(ledger.isEventEffective(events[6]!.eventId)).toBe(true);
  });

  it("makes deferred start and finish events terminal when the pairing closes", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "closed-race", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const start = started(claim.eventId, challenge.challengeId, 1, 6);
    const finish = finished(start, "seat-a", 7);
    [
      challenge,
      claim,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b", 4),
      readyChanged("alice", claim.eventId, "runtime-a", true, 5),
      start,
      finish,
    ].forEach((payload, index) => ledger.apply({ serial: index + 1, payload }));
    expect(ledger.eventStatus(start.eventId)).toBe("deferred");
    expect(ledger.eventStatus(finish.eventId)).toBe("deferred");

    ledger.apply({
      serial: 8,
      payload: pairingLeft("bob", claim.eventId, "runtime-b", 8),
    });
    expect(ledger.eventStatus(start.eventId)).toBe("rejected");
    expect(ledger.eventStatus(finish.eventId)).toBe("rejected");
  });

  it("counts draws, excludes neutral endings, and ranks standings by wins then win rate", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    appendCompletedMatch(ledger, "draw-series", 1, "draw");
    appendCompletedMatch(ledger, "neutral-series", 20, "desync");
    appendCompletedMatch(ledger, "bob-series", 40, "seat-b");

    expect(ledger.view()).toMatchObject({
      counts: { completed: 3 },
      standings: [
        { player: { id: "bob" }, wins: 1, losses: 0, draws: 1, games: 2, winRate: 0.5 },
        { player: { id: "alice" }, wins: 0, losses: 1, draws: 1, games: 2, winRate: 0 },
      ],
      headToHead: [{
        winsByPlayer: { alice: 0, bob: 1 },
        draws: 1,
      }],
    });
  });

  it("records an explicit participant concession as an opponent win", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "concession-series", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const start = started(claim.eventId, challenge.challengeId, 1, 7);
    const concession = conceded(start, "alice", 8);
    [
      challenge,
      claim,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b", 4),
      readyChanged("alice", claim.eventId, "runtime-a", true, 5),
      readyChanged("bob", claim.eventId, "runtime-b", true, 6),
      start,
      concession,
    ].forEach((payload, index) => ledger.apply({ serial: index + 1, payload }));

    expect(ledger.view("alice")).toMatchObject({
      activity: { kind: "idle" },
      counts: { live: 0, completed: 1 },
      recentResults: [{
        matchId: start.matchId,
        result: {
          outcome: "seat-b",
          reason: "forfeit",
          completedBy: "alice",
        },
      }],
      standings: [
        { player: { id: "bob" }, wins: 1, losses: 0, draws: 0, games: 1 },
        { player: { id: "alice" }, wins: 0, losses: 1, draws: 0, games: 1 },
      ],
      headToHead: [{ winsByPlayer: { alice: 0, bob: 1 }, draws: 0 }],
      seriesScores: [{ winsByPlayer: { alice: 0, bob: 1 }, completedRounds: 1 }],
    });
    expect(ledger.eventStatus(concession.eventId)).toBe("effective");
    expect(ledger.apply({ serial: 99, payload: concession })).toBe(false);
    expect(ledger.view().standings).toMatchObject([
      { player: { id: "bob" }, wins: 1, games: 1 },
      { player: { id: "alice" }, losses: 1, games: 1 },
    ]);
  });

  it("retries a concession that arrives while its valid start is still deferred", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "concession-race", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const start = started(claim.eventId, challenge.challengeId, 1, 6);
    const concession = conceded(start, "bob", 7);
    [
      challenge,
      claim,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b", 4),
      readyChanged("alice", claim.eventId, "runtime-a", true, 5),
      start,
      concession,
    ].forEach((payload, index) => ledger.apply({ serial: index + 1, payload }));

    expect(ledger.eventStatus(start.eventId)).toBe("deferred");
    expect(ledger.eventStatus(concession.eventId)).toBe("deferred");

    ledger.apply({
      serial: 8,
      payload: readyChanged("bob", claim.eventId, "runtime-b", true, 8),
    });

    expect(ledger.view("bob")).toMatchObject({
      activity: { kind: "idle" },
      counts: { live: 0, completed: 1 },
      recentResults: [{
        result: { outcome: "seat-a", reason: "forfeit", completedBy: "bob" },
      }],
    });
    expect(ledger.eventStatus(concession.eventId)).toBe("effective");
  });

  it("rejects a concession from an actor outside the committed pairing", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "outsider-concession", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const start = started(claim.eventId, challenge.challengeId, 1, 7);
    const outsider: MatchConceded = {
      ...conceded(start, "alice", 8),
      eventId: `${start.matchId}:conceded:charlie`,
      actor: { id: "charlie", displayName: "CHARLIE" },
    };
    [
      challenge,
      claim,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b", 4),
      readyChanged("alice", claim.eventId, "runtime-a", true, 5),
      readyChanged("bob", claim.eventId, "runtime-b", true, 6),
      start,
      outsider,
    ].forEach((payload, index) => ledger.apply({ serial: index + 1, payload }));

    expect(ledger.view()).toMatchObject({ counts: { live: 1, completed: 0 } });
    expect(ledger.eventStatus(outsider.eventId)).toBe("rejected");
  });

  it("preserves canonical concession precedence when multiple terminals wait on a deferred start", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "terminal-race", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const start = started(claim.eventId, challenge.challengeId, 1, 6);
    const concession = conceded(start, "alice", 7);
    const laterFinish = finished(start, "seat-a", 8);
    [
      challenge,
      claim,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b", 4),
      readyChanged("alice", claim.eventId, "runtime-a", true, 5),
      start,
      concession,
      laterFinish,
      readyChanged("bob", claim.eventId, "runtime-b", true, 9),
    ].forEach((payload, index) => ledger.apply({ serial: index + 1, payload }));

    expect(ledger.view().recentResults[0]?.result).toMatchObject({
      outcome: "seat-b",
      reason: "forfeit",
      completedBy: "alice",
    });
    expect(ledger.eventStatus(concession.eventId)).toBe("effective");
    expect(ledger.eventStatus(laterFinish.eventId)).toBe("rejected");
  });

  it("keeps a normal first finish authoritative over a later connection-loss fallback", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const start = appendCompletedMatch(ledger, "series", 1, "seat-a");
    const connectionLossFallback = {
      ...finished(start, "desync", 9),
      // Result authority, not a caller-controlled backdated clock, owns finality.
      logicalClock: 1,
    };
    ledger.apply({ serial: 9, payload: connectionLossFallback });

    expect(ledger.view()).toMatchObject({
      counts: { completed: 1 },
      recentResults: [{
        conflicted: false,
        variantCount: 1,
        result: { outcome: "seat-a", reason: "top-out" },
      }],
      standings: [
        { player: { id: "alice" }, wins: 1, losses: 0, draws: 0, games: 1 },
        { player: { id: "bob" }, wins: 0, losses: 1, draws: 0, games: 1 },
      ],
      headToHead: [{ winsByPlayer: { alice: 1, bob: 0 }, draws: 0 }],
      seriesScores: [{ winsByPlayer: { alice: 1, bob: 0 }, completedRounds: 1 }],
    });
    expect(ledger.eventStatus(connectionLossFallback.eventId)).toBe("rejected");
  });

  it("lets a concession supersede an earlier technical fallback", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const start = appendCompletedMatch(ledger, "concession-after-fallback", 1, "desync");
    const fallback = finished(start, "desync", 8);
    const concession = conceded(start, "bob", 9);

    ledger.apply({ serial: 9, payload: concession });

    expect(ledger.view().recentResults[0]?.result).toMatchObject({
      outcome: "seat-a",
      reason: "forfeit",
      completedBy: "bob",
    });
    expect(ledger.eventStatus(fallback.eventId)).toBe("rejected");
    expect(ledger.eventStatus(concession.eventId)).toBe("effective");
  });

  it("rejects a concession after a normal result is already authoritative", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const start = appendCompletedMatch(ledger, "late-concession", 1, "seat-a");
    const normal = finished(start, "seat-a", 8);
    const concession = conceded(start, "alice", 9);

    ledger.apply({ serial: 9, payload: concession });

    expect(ledger.view().recentResults[0]?.result).toMatchObject({
      outcome: "seat-a",
      reason: "top-out",
    });
    expect(ledger.eventStatus(normal.eventId)).toBe("effective");
    expect(ledger.eventStatus(concession.eventId)).toBe("rejected");
  });

  it("lets a committed simulation result supersede an earlier technical fallback", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const start = appendCompletedMatch(ledger, "series", 1, "desync");
    const fallback = finished(start, "desync", 8);
    const laterNormalFinish = finished(start, "seat-a", 9);
    ledger.apply({ serial: 9, payload: laterNormalFinish });

    expect(ledger.view()).toMatchObject({
      counts: { completed: 1 },
      recentResults: [{
        conflicted: false,
        variantCount: 1,
        result: { outcome: "seat-a", reason: "top-out" },
      }],
      standings: [
        { player: { id: "alice" }, wins: 1, losses: 0, draws: 0, games: 1 },
        { player: { id: "bob" }, wins: 0, losses: 1, draws: 0, games: 1 },
      ],
      headToHead: [{ winsByPlayer: { alice: 1, bob: 0 }, draws: 0 }],
      seriesScores: [{ winsByPlayer: { alice: 1, bob: 0 }, completedRounds: 1 }],
    });
    expect(ledger.eventStatus(laterNormalFinish.eventId)).toBe("effective");
    expect(ledger.eventStatus(fallback.eventId)).toBe("rejected");
  });

  it("converges on a normal result over a technical fallback with unrelated serials", () => {
    const first = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const second = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "finish-authority", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const start = started(claim.eventId, challenge.challengeId, 1, 7);
    const fallback = finished(start, "desync", 8);
    const normal = finished(start, "seat-b", 9);
    const events = [
      challenge,
      claim,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b", 4),
      readyChanged("alice", claim.eventId, "runtime-a", true, 5),
      readyChanged("bob", claim.eventId, "runtime-b", true, 6),
      start,
      fallback,
      normal,
    ];

    events.forEach((payload, index) => first.apply({ serial: index + 1, payload }));
    [...events].reverse().forEach((payload, index) => {
      second.apply({ serial: 5_000 + index * 31, payload });
    });

    expect(second.view()).toEqual(first.view());
    expect(first.view().recentResults[0]?.result).toMatchObject({
      outcome: "seat-b",
      reason: "top-out",
    });
    expect(first.eventStatus(fallback.eventId)).toBe("rejected");
    expect(second.eventStatus(normal.eventId)).toBe("effective");
  });

  it("keeps canonical first authority when two normal finishes disagree", () => {
    const first = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const second = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "normal-conflict", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const start = started(claim.eventId, challenge.challengeId, 1, 7);
    const canonical = finished(start, "seat-a", 8);
    const conflicting = finished(start, "seat-b", 9);
    const events = [
      challenge,
      claim,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b", 4),
      readyChanged("alice", claim.eventId, "runtime-a", true, 5),
      readyChanged("bob", claim.eventId, "runtime-b", true, 6),
      start,
      canonical,
      conflicting,
    ];

    events.forEach((payload, index) => first.apply({ serial: index + 1, payload }));
    [...events].reverse().forEach((payload, index) => {
      second.apply({ serial: 9_000 + index * 13, payload });
    });

    expect(second.view()).toEqual(first.view());
    expect(first.view().recentResults[0]?.result.outcome).toBe("seat-a");
    expect(first.eventStatus(canonical.eventId)).toBe("effective");
    expect(second.eventStatus(conflicting.eventId)).toBe("rejected");
  });

  it("keeps only the latest twenty result rows while retaining all aggregates", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    for (let index = 0; index < 21; index += 1) {
      appendCompletedMatch(ledger, `series-${index}`, index * 10 + 1, "seat-a");
    }

    const view = ledger.view();
    expect(view.counts.completed).toBe(21);
    expect(view.recentResults).toHaveLength(20);
    expect(view.recentResults[0]?.matchId).toBe("series-20:round:1");
    expect(view.recentResults.some((entry) => entry.matchId === "series-0:round:1"))
      .toBe(false);
    expect(view.standings[0]).toMatchObject({ player: { id: "alice" }, wins: 21 });
  });

  it("uses canonical event order for recent history presentation", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const older = appendCompletedMatch(ledger, "logical-older", 1, "seat-a");
    const newer = appendCompletedMatch(ledger, "logical-newer", 20, "seat-a");

    expect(ledger.apply({ serial: 100, payload: finished(older, "seat-a", 8) }))
      .toBe(false);
    expect(ledger.apply({ serial: 101, payload: finished(newer, "seat-a", 27) }))
      .toBe(false);

    expect(ledger.view().recentResults.map((entry) => entry.matchId).slice(0, 2))
      .toEqual([newer.matchId, older.matchId]);
  });

  it("orders tied Practice records by the convergent application tuple", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    ledger.apply({ serial: 20, payload: practiceCompleted("alice", 1_000, 1) });
    ledger.apply({ serial: 10, payload: practiceCompleted("bob", 1_000, 2) });

    expect(ledger.view().practice.leaderboard.map((entry) => entry.player.id))
      .toEqual(["alice", "bob"]);
    expect(ledger.view().practice.record?.player.id).toBe("alice");
  });

  it("resolves a conflicting event id from payload bytes on every replica", () => {
    const first = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const second = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const canonical = created("alice", "canonical", 1);
    const conflicting = {
      ...canonical,
      actor: { id: "zed", displayName: "ZED" },
      challengeId: "conflicting",
    };

    first.apply({ serial: 1, payload: conflicting });
    first.apply({ serial: 2, payload: canonical });
    first.apply({ serial: 3, payload: canonical });
    second.apply({ serial: 3, payload: canonical });
    second.apply({ serial: 2, payload: conflicting });

    expect(first.view()).toEqual(second.view());
    expect(first.view().openChallenges[0]?.challengeId).toBe("canonical");
  });

  it("ignores a lexicographically later conflicting payload regardless of receipt order", () => {
    const ledger = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const canonical = created("alice", "canonical", 1);
    const conflicting = {
      ...canonical,
      actor: { id: "zed", displayName: "ZED" },
      challengeId: "conflicting",
    };

    expect(ledger.apply({ serial: 1, payload: canonical })).toBe(true);
    expect(ledger.apply({ serial: 2, payload: conflicting })).toBe(false);
    expect(ledger.view().openChallenges[0]?.challengeId).toBe("canonical");
  });

  it("converges when replicas assign unrelated serial cursors", () => {
    const first = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const second = new CompetitionLedger({ currentRulesHash: RULES_HASH });
    const challenge = created("alice", "replica-order", 1);
    const claim = claimed("bob", challenge.challengeId, challenge.vacancyId, 2);
    const start = started(claim.eventId, challenge.challengeId, 1, 7);
    const events = [
      challenge,
      claim,
      runtimeClaimed("alice", claim.eventId, "runtime-a", 3),
      runtimeClaimed("bob", claim.eventId, "runtime-b", 4),
      readyChanged("alice", claim.eventId, "runtime-a", true, 5),
      readyChanged("bob", claim.eventId, "runtime-b", true, 6),
      start,
      finished(start, "seat-a", 8),
      practiceCompleted("charlie", 1_500, 9),
    ];

    events.forEach((payload, index) => {
      first.apply({ serial: index + 1, payload });
    });
    [...events].reverse().forEach((payload, index) => {
      second.apply({ serial: 10_000 + index * 17, payload });
    });

    expect(second.view("alice")).toEqual(first.view("alice"));
  });
});
