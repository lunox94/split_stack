import { describe, expect, it } from "vitest";

import {
  CHAT_INFO_MAX_CHARACTERS,
  CHAT_SUMMARY_MAX_CHARACTERS,
  challengeCancelledFeedback,
  challengeHref,
  challengeJoinedFeedback,
  challengeOpenedFeedback,
  liveMatchHref,
  matchResultFeedback,
  matchResultHref,
  matchStartedFeedback,
  practiceLeaderboardHref,
  practiceRecordFeedback,
  projectChatUpdate,
  rematchRequestedFeedback,
  tournamentSummary,
  type MatchResultFeedbackInput,
} from "../../src/app/chat-feedback";

const activity = { waiting: 2, live: 3 };

function resultInput(
  outcome: MatchResultFeedbackInput["outcome"],
): MatchResultFeedbackInput {
  return {
    matchId: "challenge-1:round:1",
    seatA: { id: "alice-id", displayName: "Alice", score: 48_200 },
    seatB: { id: "bob-id", displayName: "Bob", score: 41_750 },
    outcome,
    headToHead: { seatAWins: 3, seatBWins: 2 },
    activity,
  };
}

describe("chat feedback routes and summary", () => {
  it("uses a compact activity summary within the messenger display budget", () => {
    expect(tournamentSummary(activity)).toBe("2 wait · 3 live");
    expect(tournamentSummary({ waiting: 4_096, live: 4_096 })).toBe(
      "4k wait · 4k live",
    );
    expect(
      Array.from(tournamentSummary({ waiting: 999_999, live: 999_999 })).length,
    ).toBeLessThanOrEqual(CHAT_SUMMARY_MAX_CHARACTERS);
    expect(() => tournamentSummary({ waiting: -1, live: 0 })).toThrow(/non-negative/i);
  });

  it("builds relative hash routes and encodes every opaque identifier", () => {
    expect(challengeHref("challenge/one?# ü")).toBe(
      "index.html#lobby/challenge/challenge%2Fone%3F%23%20%C3%BC",
    );
    expect(liveMatchHref("match:1/2")).toBe("index.html#match/match%3A1%2F2");
    expect(matchResultHref("match:1/2")).toBe("index.html#result/match%3A1%2F2");
    expect(practiceLeaderboardHref("rules#v2")).toBe(
      "index.html#practice/leaderboard/rules%23v2",
    );
    expect(challengeHref("challenge-1")).not.toMatch(/^[a-z]+:\/\//i);
    expect(() => matchResultHref("")).toThrow(/match ID/i);
  });
});

describe("challenge and match lifecycle feedback", () => {
  it("announces opened challenges without notifying the chat", () => {
    expect(
      challengeOpenedFeedback({
        actorName: "Alice",
        challengeId: "challenge-1",
        activity,
      }),
    ).toEqual({
      info: "Alice is waiting for an opponent.",
      href: "index.html#lobby/challenge/challenge-1",
      summary: "2 wait · 3 live",
    });
  });

  it.each([
    {
      context: "while waiting for an opponent",
      activity: { waiting: 1, live: 3 },
      summary: "1 wait · 3 live",
    },
    {
      context: "after an opponent joins but before countdown",
      activity: { waiting: 0, live: 3 },
      summary: "0 wait · 3 live",
    },
  ])(
    "keeps chat silent when the creator cancels $context",
    ({ activity, summary }) => {
      const feedback = challengeCancelledFeedback({
        actorName: "Alice",
        challengeId: "challenge-1",
        activity,
      });

      expect(feedback).toEqual({ summary });
      expect(feedback).not.toHaveProperty("info");
      expect(feedback).not.toHaveProperty("href");
      expect(feedback).not.toHaveProperty("notify");
    },
  );

  it("keeps hostile display text inline and bounded", () => {
    const feedback = challengeOpenedFeedback({
      actorName: "A very\nlong\tplayer name that cannot fit in chat",
      challengeId: "challenge-1",
      activity,
    });

    expect(feedback.info).not.toMatch(/[\r\n\t]/);
    expect(Array.from(feedback.info ?? "").length).toBeLessThanOrEqual(
      CHAT_INFO_MAX_CHARACTERS,
    );
  });

  it("notifies only the challenge creator when a seat is claimed", () => {
    const feedback = challengeJoinedFeedback({
      joinerName: "Bob",
      creatorId: "alice-id",
      challengeId: "challenge-1",
      activity: { waiting: 1, live: 3 },
    });

    expect(feedback).toEqual({
      href: "index.html#lobby/challenge/challenge-1",
      summary: "1 wait · 3 live",
      notify: { "alice-id": "Bob joined your challenge" },
    });
    expect(feedback).not.toHaveProperty("info");
    expect(feedback.notify).not.toHaveProperty("*");
  });

  it("announces a match only when its committed start is published", () => {
    expect(
      matchStartedFeedback({
        seatAName: "Alice",
        seatBName: "Bob",
        matchId: "challenge-1:round:1",
        activity: { waiting: 2, live: 4 },
      }),
    ).toEqual({
      info: "Alice vs Bob started.",
      href: "index.html#match/challenge-1%3Around%3A1",
      summary: "2 wait · 4 live",
    });
  });
});

describe("result and follow-up feedback", () => {
  it("puts the winner first and includes both scores and updated head-to-head", () => {
    const seatAWin = matchResultFeedback(resultInput("seat-a"));
    expect(seatAWin).toEqual({
      info: "Alice 48,200–41,750 Bob · H2H 3–2",
      href: "index.html#result/challenge-1%3Around%3A1",
      summary: "2 wait · 3 live",
      notify: {
        "alice-id": "Alice 48,200–41,750 Bob · H2H 3–2",
        "bob-id": "Alice 48,200–41,750 Bob · H2H 3–2",
      },
    });

    const seatBInput = resultInput("seat-b");
    seatBInput.headToHead = { seatAWins: 2, seatBWins: 3 };
    expect(matchResultFeedback(seatBInput).info).toBe(
      "Bob 41,750–48,200 Alice · H2H 3–2",
    );
  });

  it("labels draws and generic neutral endings while retaining scores and H2H", () => {
    const draw = resultInput("draw");
    draw.seatB.score = draw.seatA.score;
    expect(matchResultFeedback(draw).info).toBe(
      "Alice 48,200–48,200 Bob · Draw · H2H 3–2",
    );

    const neutral = resultInput("neutral");
    expect(matchResultFeedback(neutral).info).toBe(
      "No result · standings unchanged",
    );
    expect(matchResultFeedback(neutral).notify).toEqual({
      "alice-id": "No result · standings unchanged",
      "bob-id": "No result · standings unchanged",
    });

  });

  it("keeps neutral connection-loss cleanup silent while updating the activity summary", () => {
    const connectionLost = resultInput("neutral");
    connectionLost.reason = "connection-lost";

    expect(matchResultFeedback(connectionLost)).toEqual({
      summary: "2 wait · 3 live",
    });
  });

  it("announces a concession once with the conceding player and winner", () => {
    const concession = resultInput("seat-b");
    concession.reason = "concession";

    expect(matchResultFeedback(concession)).toEqual({
      info: "Alice conceded · Bob wins",
      href: "index.html#result/challenge-1%3Around%3A1",
      summary: "2 wait · 3 live",
      notify: {
        "alice-id": "Alice conceded · Bob wins",
        "bob-id": "Alice conceded · Bob wins",
      },
    });
  });

  it("rejects a result that would notify the same seat twice", () => {
    const invalid = resultInput("seat-a");
    invalid.seatB.id = invalid.seatA.id;
    expect(() => matchResultFeedback(invalid)).toThrow(/different/i);
  });

  it("targets a rematch request only at the opponent and leaves chat silent", () => {
    const feedback = rematchRequestedFeedback({
      requesterName: "Alice",
      opponentId: "bob-id",
      matchId: "challenge-1:round:1",
      activity,
    });

    expect(feedback).toEqual({
      href: "index.html#result/challenge-1%3Around%3A1",
      summary: "2 wait · 3 live",
      notify: { "bob-id": "Alice requested a rematch" },
    });
    expect(feedback).not.toHaveProperty("info");
    expect(feedback.notify).not.toHaveProperty("*");
  });
});

describe("Practice record feedback", () => {
  it("announces only a strictly higher chat record", () => {
    expect(
      practiceRecordFeedback({
        playerName: "Marta",
        score: 103_750,
        previousChatRecord: 100_000,
        rulesHash: "rules/v2",
        activity,
      }),
    ).toEqual({
      info: "Marta set Practice record: 103,750",
      href: "index.html#practice/leaderboard/rules%2Fv2",
      summary: "2 wait · 3 live",
    });
    expect(
      practiceRecordFeedback({
        playerName: "Marta",
        score: 100_000,
        previousChatRecord: 100_000,
        rulesHash: "rules/v2",
        activity,
      }),
    ).toBeNull();
    expect(
      practiceRecordFeedback({
        playerName: "Marta",
        score: 99_999,
        previousChatRecord: 100_000,
        rulesHash: "rules/v2",
        activity,
      }),
    ).toBeNull();
  });

  it("attaches metadata without mutating the caller-owned notification map", () => {
    const notify = { "alice-id": "Opponent found" };
    const metadata = {
      summary: "1 wait · 0 live",
      notify,
    };
    const payload = { schema: "fixture/v1", value: 1 } as const;

    const projected = projectChatUpdate(payload, metadata);
    notify["alice-id"] = "changed";

    expect(projected).toEqual({
      payload,
      summary: "1 wait · 0 live",
      notify: { "alice-id": "Opponent found" },
    });
  });
});
