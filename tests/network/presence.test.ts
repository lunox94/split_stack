import { describe, expect, it } from "vitest";

import { ManualClock } from "../../src/network/in-memory";
import {
  AdvisoryPresenceTracker,
  PRESENCE_SCHEMA_V2,
  decodePresenceFrame,
  encodePresenceFrame,
  isPresenceFrameV2,
  type PresenceFrameV2,
} from "../../src/network/presence";

function frame(
  actorId = "alice",
  challengeId = "challenge-1",
  runtimeId = "runtime-a",
): PresenceFrameV2 {
  return {
    schema: PRESENCE_SCHEMA_V2,
    actor: { id: actorId, displayName: actorId === "alice" ? "Alice" : "Bob" },
    challengeId,
    runtimeId,
  };
}

describe("advisory presence codec", () => {
  it("round-trips the bounded v2 actor, challenge, and runtime identity", () => {
    const original = frame();
    const decoded = decodePresenceFrame(encodePresenceFrame(original));

    expect(decoded).toEqual({ ok: true, value: original });
    if (decoded.ok) decoded.value.actor.displayName = "Changed";
    expect(original.actor.displayName).toBe("Alice");
  });

  it("strictly rejects unknown fields, old schemas, and unbounded identities", () => {
    expect(isPresenceFrameV2({ ...frame(), extra: true })).toBe(false);
    expect(
      isPresenceFrameV2({
        ...frame(),
        actor: { ...frame().actor, online: true },
      }),
    ).toBe(false);
    expect(isPresenceFrameV2({ ...frame(), schema: "split-stack/presence/v1" })).toBe(
      false,
    );
    expect(isPresenceFrameV2({ ...frame(), runtimeId: "x".repeat(257) })).toBe(false);
    expect(() =>
      encodePresenceFrame({ ...frame(), challengeId: "" } as PresenceFrameV2)
    ).toThrow(/invalid advisory presence/i);
  });

  it("contains malformed shared-channel traffic without throwing", () => {
    expect(decodePresenceFrame(Uint8Array.from([0xc3, 0x28]))).toEqual({
      ok: false,
      error: "invalid-utf8",
    });
    expect(decodePresenceFrame(new TextEncoder().encode("{"))).toEqual({
      ok: false,
      error: "invalid-json",
    });
    expect(
      decodePresenceFrame(new TextEncoder().encode(JSON.stringify({ protocol: 1 }))),
    ).toEqual({ ok: false, error: "invalid-frame" });
    expect(decodePresenceFrame(encodePresenceFrame(frame()), { maxBytes: 8 })).toEqual({
      ok: false,
      error: "too-large",
    });
    expect(() => encodePresenceFrame(frame(), { maxBytes: 8 })).toThrow(/byte limit/i);
  });
});

describe("receiver-local advisory presence", () => {
  it("uses only local receive time and expires at the configured maximum age", () => {
    const clock = new ManualClock(100);
    const tracker = new AdvisoryPresenceTracker({ clock, maxAgeMs: 5_000 });

    expect(tracker.receive(encodePresenceFrame(frame()))).toMatchObject({ ok: true });
    expect(tracker.status("alice", "challenge-1")).toEqual({
      actorId: "alice",
      challengeId: "challenge-1",
      online: true,
      lastSeenAtMs: 100,
      runtimeIds: ["runtime-a"],
    });

    clock.advance(5_000);
    expect(tracker.isOnline("alice", "challenge-1")).toBe(true);
    clock.advance(1);
    expect(tracker.status("alice", "challenge-1")).toEqual({
      actorId: "alice",
      challengeId: "challenge-1",
      online: false,
      lastSeenAtMs: 100,
      runtimeIds: [],
    });
  });

  it("refreshes a runtime without allowing an older receive to move last-seen backwards", () => {
    const tracker = new AdvisoryPresenceTracker({
      clock: new ManualClock(0),
      maxAgeMs: 100,
    });

    tracker.observe(frame(), 20);
    tracker.observe({ ...frame(), actor: { id: "alice", displayName: "Alice Updated" } }, 10);

    expect(tracker.status("alice", "challenge-1", 20).lastSeenAtMs).toBe(20);
    expect(tracker.listOnline({ atMs: 20 })[0]?.actor.displayName).toBe("Alice");
  });

  it("lists fresh runtimes deterministically and filters by challenge", () => {
    const clock = new ManualClock(50);
    const tracker = new AdvisoryPresenceTracker({ clock, maxAgeMs: 100 });
    tracker.observe(frame("alice", "challenge-1", "runtime-b"));
    tracker.observe(frame("alice", "challenge-1", "runtime-a"));
    tracker.observe(frame("bob", "challenge-2", "runtime-c"));

    expect(tracker.status("alice", "challenge-1").runtimeIds).toEqual([
      "runtime-a",
      "runtime-b",
    ]);
    expect(
      tracker.listOnline({ challengeId: "challenge-1" }).map((entry) => entry.runtimeId),
    ).toEqual(["runtime-a", "runtime-b"]);
    expect(tracker.listOnline().map((entry) => entry.actor.id)).toEqual([
      "alice",
      "alice",
      "bob",
    ]);

    const firstView = tracker.listOnline();
    firstView[0]!.actor.displayName = "Mutated";
    expect(tracker.listOnline()[0]?.actor.displayName).toBe("Alice");
  });

  it("bounds hostile runtime churn by evicting the oldest observation", () => {
    const tracker = new AdvisoryPresenceTracker({
      clock: new ManualClock(0),
      maxAgeMs: 100,
      maxEntries: 2,
    });
    tracker.observe(frame("alice", "challenge-1", "runtime-a"), 0);
    tracker.observe(frame("bob", "challenge-2", "runtime-b"), 1);
    tracker.observe(frame("charlie", "challenge-3", "runtime-c"), 2);

    expect(tracker.status("alice", "challenge-1", 2).lastSeenAtMs).toBeNull();
    expect(tracker.isOnline("bob", "challenge-2", 2)).toBe(true);
    expect(tracker.isOnline("charlie", "challenge-3", 2)).toBe(true);
  });

  it("ignores non-presence hub frames without changing advisory state", () => {
    const tracker = new AdvisoryPresenceTracker({ clock: new ManualClock(0) });
    const consumeHubFrame: (data: Uint8Array) => void = (data) => {
      tracker.receive(data);
    };

    consumeHubFrame(new TextEncoder().encode(JSON.stringify({
      protocol: 1,
      matchId: "match-1",
      kind: "KEEPALIVE",
    })));

    expect(tracker.listOnline()).toEqual([]);
    expect(tracker.isOnline("alice", "challenge-1")).toBe(false);
  });

  it("rejects invalid local freshness and capacity configuration", () => {
    expect(() => new AdvisoryPresenceTracker({ maxAgeMs: -1 })).toThrow(/maximum age/i);
    expect(() => new AdvisoryPresenceTracker({ maxEntries: 0 })).toThrow(/entry limit/i);
    expect(() => new AdvisoryPresenceTracker({ maxFrameBytes: 0 })).toThrow(/byte limit/i);
    expect(() =>
      new AdvisoryPresenceTracker({ clock: { now: () => Number.NaN } })
    ).toThrow(/receive time/i);
  });
});
