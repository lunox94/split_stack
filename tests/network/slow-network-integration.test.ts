import { describe, expect, it, vi } from "vitest";

import { CompetitiveSession } from "../../src/match/competitive-session";
import {
  ManualClock,
  ShapedRealtimeBus,
} from "../../src/network/in-memory";

interface SlowNetworkPair {
  clock: ManualClock;
  bus: ShapedRealtimeBus;
  a: CompetitiveSession;
  b: CompetitiveSession;
}

function createSlowNetworkPair(options: {
  onAStartCommitted?: () => void;
  onBStartCommitted?: () => void;
} = {}): SlowNetworkPair {
  const clock = new ManualClock(1_000);
  const bus = new ShapedRealtimeBus(clock);
  bus.configureRoute("runtime-a", "runtime-b", {
    baseLatencyMs: 375,
    jitter: { kind: "seeded", seed: 7, maxDeviationMs: 20 },
    loss: { kind: "script", drops: [true] },
    duplication: { extraCopies: [1], repeat: true },
  });
  bus.configureRoute("runtime-b", "runtime-a", {
    baseLatencyMs: 375,
    jitter: { kind: "seeded", seed: 11, maxDeviationMs: 20 },
    loss: { kind: "script", drops: [true] },
    duplication: { extraCopies: [1], repeat: true },
  });

  const a = new CompetitiveSession({
    matchId: "slow-network-match",
    seat: "a",
    identity: {
      senderId: "player-a",
      sessionId: "session-a",
      displayName: "A",
    },
    peer: {
      senderId: "player-b",
      sessionId: "session-b",
      displayName: "B",
    },
    rulesHash: "rules-v1-hash",
    clock,
    transport: bus.connect("runtime-a"),
    createSeed: () => "00112233445566778899aabbccddeeff",
    ...(options.onAStartCommitted === undefined
      ? {}
      : { onStartCommitted: options.onAStartCommitted }),
  });
  const b = new CompetitiveSession({
    matchId: "slow-network-match",
    seat: "b",
    identity: {
      senderId: "player-b",
      sessionId: "session-b",
      displayName: "B",
    },
    peer: {
      senderId: "player-a",
      sessionId: "session-a",
      displayName: "A",
    },
    rulesHash: "rules-v1-hash",
    clock,
    transport: bus.connect("runtime-b"),
    ...(options.onBStartCommitted === undefined
      ? {}
      : { onStartCommitted: options.onBStartCommitted }),
  });
  return { clock, bus, a, b };
}

function advance(pair: SlowNetworkPair, milliseconds: number, stepMs = 25): void {
  let remainingMs = milliseconds;
  while (remainingMs > 0) {
    const elapsedMs = Math.min(stepMs, remainingMs);
    pair.clock.advance(elapsedMs);
    pair.bus.pump();
    pair.a.pump();
    pair.b.pump();
    remainingMs -= elapsedMs;
  }
}

function advanceUntil(
  pair: SlowNetworkPair,
  predicate: () => boolean,
  timeoutMs: number,
): void {
  for (let elapsedMs = 0; elapsedMs < timeoutMs; elapsedMs += 25) {
    if (predicate()) return;
    advance(pair, 25, 25);
  }
}

describe("CompetitiveSession over a shaped slow network", () => {
  it("starts in sync across a duplicated 750 ms RTT path with startup loss", () => {
    const onAStartCommitted = vi.fn();
    const onBStartCommitted = vi.fn();
    const pair = createSlowNetworkPair({
      onAStartCommitted,
      onBStartCommitted,
    });

    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    pair.b.setReady(true);

    advanceUntil(
      pair,
      () =>
        pair.a.view().phase === "countdown" &&
        pair.b.view().phase === "countdown",
      12_000,
    );

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    expect(pair.a.view().configHash).toBe(pair.b.view().configHash);
    expect(pair.a.view().countdownTicks).toBe(pair.b.view().countdownTicks);
    expect(onAStartCommitted).toHaveBeenCalledTimes(1);
    expect(onBStartCommitted).toHaveBeenCalledTimes(1);

    advanceUntil(
      pair,
      () =>
        pair.a.view().phase === "playing" &&
        pair.b.view().phase === "playing",
      5_000,
    );

    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    expect(pair.a.view().matchTick).toBe(pair.b.view().matchTick);
    expect(onAStartCommitted).toHaveBeenCalledTimes(1);
    expect(onBStartCommitted).toHaveBeenCalledTimes(1);
  });
});
