import { describe, expect, it } from "vitest";

import { RULES } from "../../src/config/rules";
import { RULES_HASH } from "../../src/config/rules-hash";
import { hashCanonicalHex } from "../../src/domain/hashing";
import type { LiveMatchView } from "../../src/app/competition-ledger";
import {
  connectionLossFallbackFor,
  liveControllerRecoveryStatus,
} from "../../src/app/live-session-recovery";

const alice = { id: "alice@example.test", displayName: "Alice" };
const bob = { id: "bob@example.test", displayName: "Bob" };
const seed = "0123456789abcdef0123456789abcdef";

function liveMatch(): LiveMatchView {
  return {
    pairingId: "pairing-1",
    source: "challenge",
    challengeId: "challenge-1",
    seriesId: "challenge-1",
    round: 1,
    matchId: "challenge-1:round:1",
    seatA: alice,
    seatB: bob,
    runtimeSessionByPlayer: {
      [alice.id]: "runtime-alice",
      [bob.id]: "runtime-bob",
    },
    startedEventId: "started-1",
    start: {
      schema: "split-stack/competition/v2",
      kind: "match-started",
      eventId: "started-1",
      logicalClock: 12,
      actor: alice,
      pairingId: "pairing-1",
      seriesId: "challenge-1",
      round: 1,
      matchId: "challenge-1:round:1",
      rulesHash: RULES_HASH,
      configHash: hashCanonicalHex({
        rulesVersion: RULES.rulesVersion,
        rulesHash: RULES_HASH,
        seed,
        seatAPlayerId: alice.id,
        seatBPlayerId: bob.id,
      }),
      seed,
      seedHash: hashCanonicalHex({ seed }),
      seatAPlayerId: alice.id,
      seatBPlayerId: bob.id,
      seatASessionId: "runtime-alice",
      seatBSessionId: "runtime-bob",
    },
  };
}

describe("live controller recovery", () => {
  it("moves through interrupted and expired without fresh controller traffic", () => {
    const observedAtMs = 1_000;

    expect(liveControllerRecoveryStatus({
      observedAtMs,
      controllerSeenAtMs: [null, null],
      nowMs: observedAtMs + RULES.network.missingPeerMs - 1,
    })).toEqual({ kind: "active-elsewhere" });

    expect(liveControllerRecoveryStatus({
      observedAtMs,
      controllerSeenAtMs: [null, null],
      nowMs: observedAtMs + RULES.network.controllerReconnectGraceMs,
    })).toEqual({ kind: "interrupted", remainingSeconds: 40 });

    expect(liveControllerRecoveryStatus({
      observedAtMs,
      controllerSeenAtMs: [null, null],
      nowMs: observedAtMs + RULES.network.reconnectGraceMs,
    })).toEqual({ kind: "expired" });
  });

  it("stays active elsewhere when seat A's exact committed controller is fresh", () => {
    expect(liveControllerRecoveryStatus({
      observedAtMs: 1_000,
      controllerSeenAtMs: [59_000, 1_000],
      nowMs: 60_000,
    })).toEqual({ kind: "active-elsewhere" });
  });

  it("stays active elsewhere when seat B's exact committed controller is fresh", () => {
    expect(liveControllerRecoveryStatus({
      observedAtMs: 1_000,
      controllerSeenAtMs: [1_000, 59_000],
      nowMs: 60_000,
    })).toEqual({ kind: "active-elsewhere" });
  });

  it("builds a stable participant-only neutral finish", () => {
    const match = liveMatch();
    const first = connectionLossFallbackFor(match, alice);
    const repeated = connectionLossFallbackFor(match, alice);
    const renamed = connectionLossFallbackFor(match, {
      id: alice.id,
      displayName: "Renamed elsewhere",
    });
    const peer = connectionLossFallbackFor(match, bob);

    expect(repeated).toEqual(first);
    expect(renamed).toEqual(first);
    expect(peer.eventId).not.toBe(first.eventId);
    expect(peer.result).toEqual(first.result);
    expect(first).toMatchObject({
      schema: "split-stack/competition/v2",
      kind: "match-finished",
      logicalClock: match.start.logicalClock + 1,
      actor: alice,
      matchId: match.matchId,
      startedEventId: match.startedEventId,
      result: {
        schema: "split-stack/result/v1",
        matchId: match.matchId,
        seedHash: match.start.seedHash,
        players: [alice, bob],
        outcome: "desync",
        reason: "connection-lost",
        durationTicks: 0,
        finalLevel: 1,
        completedBy: alice.id,
      },
    });
    expect(Object.values(first.result.statsByPlayer)).toEqual([
      {
        score: 0,
        lines: 0,
        garbageSent: 0,
        powersActivated: 0,
        tetrises: 0,
        tSpinSingles: 0,
        tSpinDoubles: 0,
        tSpinTriples: 0,
      },
      {
        score: 0,
        lines: 0,
        garbageSent: 0,
        powersActivated: 0,
        tetrises: 0,
        tSpinSingles: 0,
        tSpinDoubles: 0,
        tSpinTriples: 0,
      },
    ]);
    expect(() => connectionLossFallbackFor(match, {
      id: "spectator@example.test",
      displayName: "Spectator",
    })).toThrow(/participant/i);
  });
});
