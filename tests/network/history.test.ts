import { describe, expect, it } from "vitest";

import type { MatchResult } from "../../src/domain/types";
import {
  HISTORY_MAX_MATCHES,
  HISTORY_MAX_VARIANTS_PER_MATCH,
  HistoryMaterializer,
} from "../../src/persistence/history";

function result(matchId: string, outcome: MatchResult["outcome"]): MatchResult {
  return {
    schema: "split-stack/result/v1",
    matchId,
    seedHash: `seed-${matchId}`,
    players: [
      { id: "alice", displayName: "Alice" },
      { id: "bob", displayName: "Bob" },
    ],
    outcome,
    reason: outcome === "draw" ? "simultaneous" : "top-out",
    durationTicks: 3_600,
    finalLevel: 2,
    statsByPlayer: {
      alice: {
        score: 1_000,
        lines: 10,
        garbageSent: 3,
        powersActivated: 1,
        tetrises: 1,
        tSpinSingles: 0,
        tSpinDoubles: 0,
        tSpinTriples: 0,
      },
      bob: {
        score: 800,
        lines: 8,
        garbageSent: 1,
        powersActivated: 0,
        tetrises: 0,
        tSpinSingles: 0,
        tSpinDoubles: 0,
        tSpinTriples: 0,
      },
    },
    completedBy: "alice",
  };
}

describe("durable match history", () => {
  it("keeps the latest 20 details while tallying every unique completed match", () => {
    const history = new HistoryMaterializer();
    for (let serial = 1; serial <= 21; serial += 1) {
      history.apply({ serial, payload: result(`match-${serial}`, "seat-a") });
    }
    history.apply({ serial: 22, payload: result("match-21", "seat-a") });

    const view = history.view();

    expect(view.latest).toHaveLength(20);
    expect(view.latest[0]?.result.matchId).toBe("match-21");
    expect(view.tallies).toEqual([
      {
        playerIds: ["alice", "bob"],
        winsByPlayer: { alice: 21, bob: 0 },
      },
    ]);
  });

  it("marks incompatible durable results as desync and excludes them from win tallies", () => {
    const history = new HistoryMaterializer();
    history.apply({ serial: 1, payload: result("match-1", "seat-a") });
    history.apply({ serial: 2, payload: result("match-1", "seat-b") });

    const view = history.view();

    expect(view.latest).toHaveLength(1);
    expect(view.latest[0]).toMatchObject({
      conflicted: true,
      result: { matchId: "match-1", outcome: "desync", reason: "desynchronization" },
    });
    expect(view.tallies).toEqual([]);
  });

  it("keeps a connection-loss result in recent history without changing tallies", () => {
    const history = new HistoryMaterializer();
    const interrupted = result("match-disconnected", "desync");
    interrupted.reason = "connection-lost";

    expect(history.apply({ serial: 1, payload: interrupted })).toBe(true);
    expect(history.view()).toMatchObject({
      latest: [
        {
          result: {
            matchId: "match-disconnected",
            outcome: "desync",
            reason: "connection-lost",
          },
        },
      ],
      tallies: [],
    });
  });

  it("preserves a neutral connection-loss label across peer result variants", () => {
    const history = new HistoryMaterializer();
    const first = result("match-disconnected-variants", "desync");
    first.reason = "connection-lost";
    const second = structuredClone(first);
    second.durationTicks += 2;
    second.statsByPlayer.bob!.score += 10;

    history.apply({ serial: 1, payload: first });
    history.apply({ serial: 2, payload: second });

    expect(history.view()).toMatchObject({
      latest: [
        {
          conflicted: true,
          variantCount: 2,
          result: { outcome: "desync", reason: "connection-lost" },
        },
      ],
      tallies: [],
    });
  });

  it("ignores malformed result statistics instead of materializing partial history", () => {
    const history = new HistoryMaterializer();
    const malformed = result("match-1", "seat-a") as unknown as {
      statsByPlayer: Record<string, unknown>;
    };
    malformed.statsByPlayer.bob = { score: "a lot" };

    expect(history.apply({ serial: 1, payload: malformed })).toBe(false);
    expect(history.view()).toEqual({ latest: [], tallies: [] });
  });

  it("does not let caller mutations rewrite accepted history", () => {
    const history = new HistoryMaterializer();
    const accepted = result("match-1", "seat-a");
    history.apply({ serial: 1, payload: accepted });
    accepted.outcome = "seat-b";
    const firstView = history.view();
    firstView.latest[0]!.result.outcome = "seat-b";

    expect(history.view().latest[0]?.result.outcome).toBe("seat-a");
    expect(history.view().tallies[0]?.winsByPlayer).toEqual({ alice: 1, bob: 0 });
  });

  it("does not make an old match newest when an identical update is replayed later", () => {
    const history = new HistoryMaterializer();
    history.apply({ serial: 1, payload: result("old-match", "seat-a") });
    history.apply({ serial: 2, payload: result("new-match", "seat-b") });
    history.apply({ serial: 99, payload: result("old-match", "seat-a") });

    expect(history.view().latest.map((entry) => entry.result.matchId)).toEqual([
      "new-match",
      "old-match",
    ]);
  });

  it("looks up a completed match outside the latest-20 window without exposing mutable state", () => {
    const history = new HistoryMaterializer();
    for (let serial = 1; serial <= 21; serial += 1) {
      history.apply({ serial, payload: result(`match-${serial}`, "seat-a") });
    }

    const recovered = history.findByMatchId("match-1");

    expect(recovered).toMatchObject({
      serial: 1,
      conflicted: false,
      variantCount: 1,
      result: { matchId: "match-1", outcome: "seat-a" },
    });
    recovered!.result.outcome = "seat-b";
    expect(history.findByMatchId("match-1")?.result.outcome).toBe("seat-a");
    expect(history.findByMatchId("missing")).toBeUndefined();
  });

  it("bounds adversarial match and conflict variants", () => {
    const history = new HistoryMaterializer();
    for (let serial = 1; serial <= HISTORY_MAX_MATCHES + 20; serial += 1) {
      history.apply({ serial, payload: result(`bounded-${serial}`, "seat-a") });
    }
    for (let variant = 0; variant < HISTORY_MAX_VARIANTS_PER_MATCH + 20; variant += 1) {
      const conflicting = result("bounded-1", variant % 2 === 0 ? "seat-a" : "seat-b");
      conflicting.durationTicks += variant;
      history.apply({ serial: HISTORY_MAX_MATCHES + 100 + variant, payload: conflicting });
    }

    const diagnostics = history.diagnostics();
    expect(diagnostics.matchCount).toBe(HISTORY_MAX_MATCHES);
    expect(diagnostics.maximumVariantCount).toBeLessThanOrEqual(
      HISTORY_MAX_VARIANTS_PER_MATCH,
    );
    expect(diagnostics.capacityReached).toBe(true);
  });
});
