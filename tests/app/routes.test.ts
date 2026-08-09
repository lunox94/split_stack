import { describe, expect, it, vi } from "vitest";

import {
  challengeHref,
  liveMatchHref,
  matchResultHref,
  practiceLeaderboardHref,
} from "../../src/app/chat-feedback";
import {
  MAX_ROUTE_ID_CHARACTERS,
  buildAppRouteHref,
  isRecognizedAppRouteHash,
  parseAppRoute,
  resolveAppRoute,
  type AppRoute,
} from "../../src/app/routes";

describe("v2 route hrefs", () => {
  it("builds the same contextual relative hrefs used by chat feedback", () => {
    expect(
      buildAppRouteHref({ screen: "lobby", challengeId: "challenge/1" }),
    ).toBe(challengeHref("challenge/1"));
    expect(buildAppRouteHref({ screen: "match", matchId: "match:1" })).toBe(
      liveMatchHref("match:1"),
    );
    expect(buildAppRouteHref({ screen: "result", matchId: "match:1" })).toBe(
      matchResultHref("match:1"),
    );
    expect(
      buildAppRouteHref({ screen: "practice-leaderboard", rulesHash: "rules#2" }),
    ).toBe(practiceLeaderboardHref("rules#2"));
    expect(buildAppRouteHref({ screen: "home" })).toBe("index.html");
    expect(buildAppRouteHref({ screen: "lobby" })).toBe("index.html#lobby");
  });

  it("round-trips bounded opaque identifiers without treating their content as paths", () => {
    const identifier = "opaque/segment?# ü %2F";
    const routes: AppRoute[] = [
      { screen: "lobby", challengeId: identifier },
      { screen: "match", matchId: identifier },
      { screen: "result", matchId: identifier },
      { screen: "practice-leaderboard", rulesHash: identifier },
    ];

    for (const route of routes) {
      const href = buildAppRouteHref(route);
      expect(href).toMatch(/^index\.html#/);
      expect(href).not.toContain("opaque/segment");
      expect(parseAppRoute(href)).toEqual(route);
      expect(parseAppRoute(href.slice(href.indexOf("#")))).toEqual(route);
    }
  });

  it("rejects invalid builder identifiers at the local boundary", () => {
    expect(() =>
      buildAppRouteHref({ screen: "match", matchId: "" })
    ).toThrow(/match ID/i);
    expect(() =>
      buildAppRouteHref({
        screen: "result",
        matchId: "x".repeat(MAX_ROUTE_ID_CHARACTERS + 1),
      })
    ).toThrow(/match ID/i);
    expect(() =>
      buildAppRouteHref({ screen: "lobby", challengeId: "\ud800" })
    ).toThrow(/Unicode/i);
  });
});

describe("strict v2 hash parsing", () => {
  it("distinguishes consumable app fragments from host identity context", () => {
    for (const value of [
      "#home",
      "#lobby",
      "#lobby/challenge/open",
      "#match/live",
      "#result/finished",
      "#practice/leaderboard/rules",
      "#match/%",
    ]) {
      expect(isRecognizedAppRouteHash(value), value).toBe(true);
    }
    for (const value of [
      "",
      "#",
      "#name=Alice&addr=alice%40example.test",
      "#next_peer=3",
      "#unknown=value",
    ]) {
      expect(isRecognizedAppRouteHash(value), value).toBe(false);
    }
  });

  it("treats an empty location and development identity hashes as Home", () => {
    for (const value of [
      "",
      "#",
      "index.html",
      "#home",
      "#name=Alice&addr=alice%40example.test",
      "#next_peer=3",
      "#name=%E0%A4%A&addr=broken",
      "#unknown=value",
    ]) {
      expect(parseAppRoute(value), value).toEqual({ screen: "home" });
    }
  });

  it("parses the plain Lobby route without inventing a focused challenge", () => {
    expect(parseAppRoute("#lobby")).toEqual({ screen: "lobby" });
    expect(parseAppRoute("index.html#lobby")).toEqual({ screen: "lobby" });
  });

  it("falls back to Lobby for malformed known targets without throwing", () => {
    const malformed = [
      "#match",
      "#match/",
      "#match/one/two",
      "#match/%",
      "#match/%E0%A4%A",
      "#result/id?query=1",
      "#lobby/challenge/",
      "#lobby/not-a-challenge/id",
      "#practice/leaderboard/",
      "#practice/other/rules",
      `#match/${"x".repeat(4_100)}`,
    ];

    for (const value of malformed) {
      expect(() => parseAppRoute(value), value).not.toThrow();
      expect(parseAppRoute(value), value).toEqual({ screen: "lobby" });
    }
  });

  it("falls back to Home for unrelated, absolute, and non-string input", () => {
    expect(parseAppRoute("#unrelated")).toEqual({ screen: "home" });
    expect(parseAppRoute("https://example.test/index.html#match/id")).toEqual({
      screen: "home",
    });
    expect(parseAppRoute(null as unknown as string)).toEqual({ screen: "home" });
  });
});

describe("stale target resolution", () => {
  it("resolves missing lifecycle targets to the Lobby", () => {
    const unavailable = {
      challengeExists: () => false,
      liveMatchExists: () => false,
      resultExists: () => false,
      rulesHashIsCurrent: () => false,
    };

    expect(parseAppRoute("#lobby/challenge/old", unavailable)).toEqual({
      screen: "lobby",
    });
    expect(parseAppRoute("#match/finished", unavailable)).toEqual({ screen: "lobby" });
    expect(parseAppRoute("#result/forgotten", unavailable)).toEqual({
      screen: "lobby",
    });
    expect(parseAppRoute("#practice/leaderboard/old-rules", unavailable)).toEqual({
      screen: "lobby",
    });
  });

  it("retains a target only when its relevant availability check accepts it", () => {
    const challengeExists = vi.fn((id: string) => id === "open");
    const liveMatchExists = vi.fn(() => {
      throw new Error("irrelevant check must not be called");
    });

    expect(
      parseAppRoute("#lobby/challenge/open", { challengeExists, liveMatchExists }),
    ).toEqual({ screen: "lobby", challengeId: "open" });
    expect(challengeExists).toHaveBeenCalledOnce();
    expect(liveMatchExists).not.toHaveBeenCalled();
  });

  it("contains availability failures and leaves untargeted Home/Lobby routes alone", () => {
    expect(
      parseAppRoute("#result/match-1", {
        resultExists: () => {
          throw new Error("materializer unavailable");
        },
      }),
    ).toEqual({ screen: "lobby" });
    expect(resolveAppRoute({ screen: "home" }, { resultExists: () => false })).toEqual({
      screen: "home",
    });
    expect(resolveAppRoute({ screen: "lobby" }, { challengeExists: () => false })).toEqual({
      screen: "lobby",
    });
  });
});
