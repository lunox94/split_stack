// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  presentCompetition,
  type CompetitionPresenterOptions,
} from "../../src/app/competition-presenter";
import type {
  CompetitionActor,
  CompetitionResultView,
  StartingPairingView,
} from "../../src/app/competition-ledger";
import type {
  CompetitionLiveMatchView,
  CompetitionPracticeEntryView,
  CompetitionView,
} from "../../src/app/competition-event-lifecycle";
import type { PlayerResultStats } from "../../src/domain/types";
import { createAppShell } from "../../src/ui/shell";

const ALICE: CompetitionActor = { id: "alice", displayName: "Alice" };
const BOB: CompetitionActor = { id: "bob", displayName: "Bob" };
const CAROL: CompetitionActor = { id: "carol", displayName: "Carol" };
const DAVE: CompetitionActor = { id: "dave", displayName: "Dave" };

function stats(score: number): PlayerResultStats {
  return {
    score,
    lines: 12,
    garbageSent: 4,
    powersActivated: 2,
    tetrises: 1,
    tSpinSingles: 0,
    tSpinDoubles: 0,
    tSpinTriples: 0,
  };
}

function practiceEntry(
  rank: number,
  player: CompetitionActor,
  score: number,
): CompetitionPracticeEntryView {
  return {
    rank,
    player,
    score,
    runId: `run-${player.id}`,
    durationTicks: 1_200,
    finalLevel: 4,
    finalStats: stats(score),
  };
}

function emptyView(): CompetitionView {
  return {
    counts: { waiting: 0, starting: 0, live: 0, completed: 0 },
    activity: { kind: "idle" },
    openChallenges: [],
    startingPairings: [],
    liveMatches: [],
    recentResults: [],
    standings: [],
    headToHead: [],
    seriesScores: [],
    pendingRematches: [],
    rejectedClaims: [],
    practice: {
      rulesHash: "rules",
      totalPlayers: 0,
      leaderboard: [],
      pinned: null,
      personalBest: null,
      record: null,
    },
  };
}

function startingPairing(): StartingPairingView {
  return {
    pairingId: "pairing-1",
    source: "challenge",
    challengeId: "challenge-1",
    seriesId: "challenge-1",
    round: 1,
    matchId: "match-1",
    seatA: ALICE,
    seatB: BOB,
    readyByPlayer: { alice: true, bob: false },
    runtimeSessionByPlayer: { alice: "session-a", bob: "session-b" },
  };
}

function liveMatch(): CompetitionLiveMatchView {
  return {
    ...startingPairing(),
    start: {
      kind: "match-started",
      pairingId: "pairing-1",
      seriesId: "challenge-1",
      round: 1,
      matchId: "match-1",
      rulesHash: "rules",
      configHash: "config",
      seed: "seed",
      seedHash: "seed-hash",
      seatAPlayerId: "alice",
      seatBPlayerId: "bob",
      seatASessionId: "session-a",
      seatBSessionId: "session-b",
    },
  };
}

function result(
  outcome: "seat-a" | "seat-b" | "draw" | "desync" = "seat-a",
  conflicted = false,
): CompetitionResultView {
  return {
    matchId: "match-1",
    seriesId: "challenge-1",
    round: 1,
    conflicted,
    variantCount: conflicted ? 2 : 1,
    result: {
      schema: "split-stack/result/v1",
      matchId: "match-1",
      seedHash: "seed-hash",
      players: [ALICE, BOB],
      outcome,
      reason: outcome === "desync" ? "connection-lost" : outcome === "draw" ? "simultaneous" : "top-out",
      durationTicks: 1_200,
      finalLevel: 4,
      statsByPlayer: { alice: stats(12_400), bob: stats(9_800) },
      completedBy: "alice",
    },
  };
}

function setup(
  view: CompetitionView,
  overrides: Partial<Omit<CompetitionPresenterOptions, "shell" | "view" | "self">> = {},
) {
  const shell = createAppShell(document, document.createElement("div"));
  const options: CompetitionPresenterOptions = {
    shell,
    view,
    self: ALICE,
    realtimeAvailable: true,
    isOnline: () => false,
    ...overrides,
  };
  presentCompetition(options);
  return shell;
}

describe("competition presenter", () => {
  it("preserves a transient stale-link notice while a live match is projected", () => {
    const view: CompetitionView = {
      ...emptyView(),
      counts: { waiting: 0, starting: 0, live: 1, completed: 0 },
      activity: {
        kind: "live",
        pairingId: "pairing-1",
        matchId: "match-1",
        seriesId: "challenge-1",
        round: 1,
      },
      liveMatches: [liveMatch()],
    };
    const shell = setup(emptyView());
    shell.lobbyStatus.textContent = "This link is no longer active.";

    presentCompetition({
      shell,
      view,
      self: ALICE,
      realtimeAvailable: true,
      isOnline: () => false,
    });

    expect(shell.lobbyStatus.textContent).toBe("This link is no longer active.");
  });

  it("updates Home waiting, activity counts, and Practice records", () => {
    const personal = practiceEntry(2, ALICE, 8_200);
    const record = practiceEntry(1, BOB, 10_500);
    const view: CompetitionView = {
      ...emptyView(),
      counts: { waiting: 3, starting: 1, live: 2, completed: 5 },
      activity: { kind: "waiting", challengeId: "mine" },
      practice: {
        rulesHash: "rules",
        totalPlayers: 2,
        leaderboard: [record, personal],
        pinned: null,
        personalBest: personal,
        record,
      },
    };

    const shell = setup(view);

    expect(shell.createButton.hidden).toBe(true);
    expect(shell.homeWaiting.hidden).toBe(false);
    expect(shell.cancelChallengeButton.disabled).toBe(false);
    expect(shell.practiceButton.disabled).toBe(false);
    expect(shell.lobbyActivity.textContent).toBe("3 waiting · 2 live");
    expect(shell.lobbySummary.textContent).toBe("3 waiting · 2 live");
    expect(shell.personalPracticeRecord.textContent).toBe("Your best: 8200");
    expect(shell.chatPracticeRecord.textContent).toBe("Chat record: 10500 · Bob");
    expect(shell.yourActivity.textContent).toContain("Waiting for an opponent");

    presentCompetition({
      shell,
      view,
      self: ALICE,
      realtimeAvailable: false,
      isOnline: () => false,
    });
    expect(shell.cancelChallengeButton.disabled).toBe(false);
  });

  it("preserves oldest-first rows and keeps an offline creator joinable", () => {
    const joined = vi.fn();
    const presence = vi.fn((actorId: string) => actorId === "bob");
    const view: CompetitionView = {
      ...emptyView(),
      counts: { waiting: 2, starting: 0, live: 0, completed: 0 },
      openChallenges: [
        { challengeId: "oldest", creator: BOB, rulesHash: "rules", vacancyId: "vacancy-1" },
        { challengeId: "newest", creator: CAROL, rulesHash: "rules", vacancyId: "vacancy-2" },
      ],
    };

    const shell = setup(view, { isOnline: presence, onJoinChallenge: joined });
    const rows = shell.openChallenges.querySelectorAll<HTMLLIElement>("li");

    expect(rows).toHaveLength(2);
    expect(rows[0]?.dataset.challengeId).toBe("oldest");
    expect(rows[1]?.dataset.challengeId).toBe("newest");
    expect(rows[0]?.textContent).toContain("Online");
    expect(rows[1]?.textContent).toContain("Creator offline · You can still join");
    const offlineJoin = rows[1]?.querySelector<HTMLButtonElement>("button");
    expect(offlineJoin?.disabled).toBe(false);
    expect(offlineJoin?.classList).toContain("lobby-row-action");
    expect(offlineJoin?.closest(".lobby-challenge-row")).toBe(rows[1]);
    expect(rows[1]?.querySelector(".lobby-row-copy")).not.toBeNull();
    offlineJoin?.click();
    expect(joined).toHaveBeenCalledOnce();
    expect(joined).toHaveBeenCalledWith("newest");
    expect(presence.mock.calls).toEqual([["bob", "oldest"], ["carol", "newest"]]);
  });

  it("contains advisory presence failures and only disables live actions for real constraints", () => {
    const view: CompetitionView = {
      ...emptyView(),
      counts: { waiting: 1, starting: 0, live: 1, completed: 0 },
      openChallenges: [
        { challengeId: "challenge-1", creator: BOB, rulesHash: "rules", vacancyId: "vacancy-1" },
      ],
      liveMatches: [liveMatch()],
    };
    const shell = setup(view, {
      isOnline: () => {
        throw new Error("presence transport unavailable");
      },
    });
    expect(shell.openChallenges.textContent).toContain("Creator offline · You can still join");
    expect(shell.openChallenges.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);

    presentCompetition({
      shell,
      view,
      self: ALICE,
      realtimeAvailable: false,
      isOnline: () => true,
    });
    expect(shell.openChallenges.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(shell.liveGames.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(shell.createButton.disabled).toBe(true);
    expect(shell.practiceButton.disabled).toBe(false);
  });

  it("shows readiness with an owned setup exit, and gives live games an explicit Watch callback", () => {
    const watched = vi.fn();
    const leftPairing = vi.fn();
    const pairing = startingPairing();
    const live = liveMatch();
    const otherLive: CompetitionLiveMatchView = {
      ...live,
      pairingId: "pairing-2",
      challengeId: "challenge-2",
      seriesId: "challenge-2",
      matchId: "match-2",
      seatA: CAROL,
      seatB: DAVE,
      runtimeSessionByPlayer: { carol: "session-c", dave: "session-d" },
      start: {
        ...live.start,
        pairingId: "pairing-2",
        seriesId: "challenge-2",
        matchId: "match-2",
        seatAPlayerId: CAROL.id,
        seatBPlayerId: DAVE.id,
        seatASessionId: "session-c",
        seatBSessionId: "session-d",
      },
    };
    const view: CompetitionView = {
      ...emptyView(),
      counts: { waiting: 0, starting: 1, live: 2, completed: 0 },
      activity: {
        kind: "live",
        pairingId: live.pairingId,
        matchId: live.matchId,
        seriesId: live.seriesId,
        round: live.round,
      },
      startingPairings: [pairing],
      liveMatches: [live, otherLive],
    };

    const shell = setup(view, {
      onWatchMatch: watched,
      onLeavePairing: leftPairing,
    });

    expect(shell.startingSoon.textContent).toContain("Alice (You) — Ready");
    expect(shell.startingSoon.textContent).toContain("Bob — Not ready");
    const leave = shell.startingSoon.querySelector<HTMLButtonElement>("button");
    expect(leave?.textContent).toBe("Cancel pairing");
    leave?.click();
    expect(leftPairing).toHaveBeenCalledWith("pairing-1");
    const [ownWatch, otherWatch] = shell.liveGames.querySelectorAll<HTMLButtonElement>("button");
    expect(ownWatch?.textContent).toBe("Watch");
    expect(ownWatch?.disabled).toBe(true);
    expect(otherWatch?.disabled).toBe(false);
    otherWatch?.click();
    expect(watched).toHaveBeenCalledOnce();
    expect(watched).toHaveBeenCalledWith("match-2");
    expect(shell.yourActivity.textContent).toContain("Live · Round 1");

    presentCompetition({
      shell,
      view,
      self: ALICE,
      realtimeAvailable: true,
      isOnline: () => true,
      onWatchMatch: watched,
      allowOwnedMatchWatch: true,
    });
    const replacementWatch = shell.liveGames.querySelector<HTMLButtonElement>(
      '[data-match-id="match-1"] button',
    );
    expect(replacementWatch?.disabled).toBe(false);
    replacementWatch?.click();
    expect(watched).toHaveBeenLastCalledWith("match-1");
  });

  it("explains a live commitment once while blocking other Join actions", () => {
    const live = liveMatch();
    const view: CompetitionView = {
      ...emptyView(),
      counts: { waiting: 1, starting: 0, live: 1, completed: 0 },
      activity: {
        kind: "live",
        pairingId: live.pairingId,
        matchId: live.matchId,
        seriesId: live.seriesId,
        round: live.round,
      },
      openChallenges: [{
        challengeId: "carol-challenge",
        creator: CAROL,
        rulesHash: "rules",
        vacancyId: "vacancy-carol",
      }],
      liveMatches: [live],
    };

    const shell = setup(view);
    const join = shell.openChallenges.querySelector<HTMLButtonElement>("button");

    expect(join?.disabled).toBe(true);
    expect(shell.createButton.disabled).toBe(true);
    expect(shell.createButton.dataset.availability).toBe("unavailable");
    expect(shell.createButton.getAttribute("aria-describedby")).toBe(
      shell.homeRecovery.id,
    );
    expect(shell.lobbyStatus.textContent).toBe(
      "Finish your active match before joining another challenge.",
    );
    expect(shell.lobby.contains(shell.lobbyStatus)).toBe(true);
    expect(shell.home.contains(shell.lobbyStatus)).toBe(false);
  });

  it("renders recent scores, W-L-D standings, top ten Practice scores, and a pinned own rank", () => {
    const acceptedRematch = vi.fn();
    const leaders = Array.from({ length: 10 }, (_, index) =>
      practiceEntry(
        index + 1,
        { id: `player-${index + 1}`, displayName: `Player ${index + 1}` },
        20_000 - index * 500,
      )
    );
    const pinned = practiceEntry(14, ALICE, 4_200);
    const view: CompetitionView = {
      ...emptyView(),
      counts: { waiting: 0, starting: 0, live: 0, completed: 1 },
      recentResults: [result()],
      standings: [
        { player: ALICE, wins: 3, losses: 1, draws: 1, games: 5, winRate: 0.6 },
        { player: BOB, wins: 1, losses: 3, draws: 1, games: 5, winRate: 0.2 },
      ],
      practice: {
        rulesHash: "rules",
        totalPlayers: 14,
        leaderboard: leaders,
        pinned,
        personalBest: pinned,
        record: leaders[0] ?? null,
      },
      pendingRematches: [{
        seriesId: "challenge-1",
        afterMatchId: "match-1",
        round: 2,
        seatA: ALICE,
        seatB: BOB,
        requestedByPlayerIds: ["bob"],
      }],
    };

    const shell = setup(view, { onAcceptRematch: acceptedRematch });

    expect(shell.history.textContent).toContain("Alice 12400 – 9800 Bob");
    expect(shell.history.textContent).toContain("Alice won");
    const standings = shell.standings.querySelector(
      "table.lobby-table.standings-table",
    );
    expect(standings?.querySelector("caption")?.textContent).toBe("Standings");
    expect(standings?.querySelectorAll('th[scope="col"]')).toHaveLength(5);
    expect(standings?.textContent).toContain("Alice (You)31160%");
    expect(standings?.querySelector('tr.is-local-player th[scope="row"]')?.textContent)
      .toBe("Alice (You)");
    const practice = shell.practiceLeaderboard.querySelector(
      "table.lobby-table.practice-table",
    );
    expect(practice?.querySelectorAll("tbody tr")).toHaveLength(11);
    expect(practice?.querySelector('tr[data-pinned="true"]')?.textContent)
      .toContain("#14Alice (You)4200");
    expect(
      practice?.querySelector<HTMLTableRowElement>("tr.is-local-player")?.dataset.playerId,
    )
      .toBe("alice");
    expect(shell.yourActivity.textContent).toContain("Bob requested a rematch · Round 2");
    const accept = shell.yourActivity.querySelector<HTMLButtonElement>("button");
    expect(accept?.textContent).toBe("Accept rematch");
    accept?.click();
    expect(acceptedRematch).toHaveBeenCalledWith("match-1");
  });

  it("hides empty secondary sections, always keeps challenges, and restores sections", () => {
    const shell = setup(emptyView());
    const sectionFor = (body: HTMLElement): HTMLElement =>
      body.closest<HTMLElement>("section")!;
    const secondaryBodies = [
      shell.yourActivity,
      shell.startingSoon,
      shell.liveGames,
      shell.history,
      shell.standings,
      shell.practiceLeaderboard,
    ];

    expect(sectionFor(shell.openChallenges).hidden).toBe(false);
    expect(shell.openChallenges.textContent).toContain("No one is waiting");
    for (const body of secondaryBodies) {
      expect(sectionFor(body).hidden).toBe(true);
    }

    const populated: CompetitionView = {
      ...emptyView(),
      openChallenges: [
        { challengeId: "challenge-1", creator: BOB, rulesHash: "rules", vacancyId: "vacancy-1" },
      ],
      activity: { kind: "waiting", challengeId: "challenge-1" },
      startingPairings: [startingPairing()],
      liveMatches: [liveMatch()],
      recentResults: [result()],
      standings: [
        { player: ALICE, wins: 1, losses: 0, draws: 0, games: 1, winRate: 1 },
      ],
      practice: {
        rulesHash: "rules",
        totalPlayers: 1,
        leaderboard: [practiceEntry(1, ALICE, 12_300)],
        pinned: null,
        personalBest: practiceEntry(1, ALICE, 12_300),
        record: practiceEntry(1, ALICE, 12_300),
      },
    };

    presentCompetition({
      shell,
      view: populated,
      self: ALICE,
      realtimeAvailable: true,
      isOnline: () => true,
    });

    expect(sectionFor(shell.openChallenges).hidden).toBe(false);
    for (const body of secondaryBodies) {
      expect(sectionFor(body).hidden).toBe(false);
    }

    presentCompetition({
      shell,
      view: emptyView(),
      self: ALICE,
      realtimeAvailable: true,
      isOnline: () => false,
    });

    expect(sectionFor(shell.openChallenges).hidden).toBe(false);
    expect(shell.openChallenges.querySelector('[data-empty-state="true"]')).not.toBeNull();
    for (const body of secondaryBodies) {
      expect(sectionFor(body).hidden).toBe(true);
      expect(body.querySelector('[data-empty-state="true"]')).not.toBeNull();
    }
  });
});
