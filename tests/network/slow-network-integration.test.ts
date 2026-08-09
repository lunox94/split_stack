import { describe, expect, it, vi } from "vitest";

import {
  CompetitiveSession,
  type CompetitivePhase,
} from "../../src/match/competitive-session";
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
  onAPhaseChange?: (phase: CompetitivePhase) => void;
  onBPhaseChange?: (phase: CompetitivePhase) => void;
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
    ...(options.onAPhaseChange === undefined
      ? {}
      : { onPhaseChange: options.onAPhaseChange }),
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
    ...(options.onBPhaseChange === undefined
      ? {}
      : { onPhaseChange: options.onBPhaseChange }),
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

function isOneHertzOrSuspended(intervalTicks: number | null): boolean {
  return intervalTicks === null || intervalTicks >= 60;
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

  it("keeps control traffic viable and resumes once across repeated asymmetric bursts", () => {
    const aPhases: CompetitivePhase[] = [];
    const bPhases: CompetitivePhase[] = [];
    const onAStartCommitted = vi.fn();
    const onBStartCommitted = vi.fn();
    const pair = createSlowNetworkPair({
      onAStartCommitted,
      onBStartCommitted,
      onAPhaseChange: (phase) => aPhases.push(phase),
      onBPhaseChange: (phase) => bPhases.push(phase),
    });

    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    pair.b.setReady(true);
    advanceUntil(
      pair,
      () =>
        pair.a.view().phase === "playing" &&
        pair.b.view().phase === "playing",
      17_000,
    );

    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    expect(onAStartCommitted).toHaveBeenCalledTimes(1);
    expect(onBStartCommitted).toHaveBeenCalledTimes(1);
    aPhases.length = 0;
    bPhases.length = 0;

    // Incoming traffic remains healthy while Seat A's uplink disappears.
    // The sender should shed periodic state before the five-second delivery
    // deadline so control traffic has room when the narrow route returns.
    pair.bus.configureRoute("runtime-a", "runtime-b", {
      baseLatencyMs: 150,
      loss: { kind: "script", drops: [true], repeat: true },
    });
    pair.bus.configureRoute("runtime-b", "runtime-a", {
      baseLatencyMs: 150,
      jitter: {
        kind: "script",
        offsetsMs: [0, 45, -20, 70],
        repeat: true,
      },
    });
    const impairmentStartedAtMs = pair.clock.now();
    advanceUntil(
      pair,
      () => pair.a.view().connectionStatus === "unstable",
      5_000,
    );

    expect(pair.a.view()).toMatchObject({
      phase: "playing",
      connectionStatus: "unstable",
    });
    expect(isOneHertzOrSuspended(pair.a.view().snapshotIntervalTicks)).toBe(
      true,
    );

    advanceUntil(
      pair,
      () =>
        pair.a.view().phase === "network-pause" &&
        pair.b.view().phase === "network-pause",
      3_000,
    );
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");

    const configureNarrowRoute = (): void => {
      pair.bus.configureRoute("runtime-a", "runtime-b", {
        baseLatencyMs: 180,
        jitter: {
          kind: "script",
          offsetsMs: [0, 80, -25, 40],
          repeat: true,
        },
        bandwidth: {
          bytesPerSecond: 12_000,
          burstBytes: 1_200,
          maxQueuedFrames: 24,
          maxQueuedBytes: 48_000,
        },
      });
      pair.bus.configureRoute("runtime-b", "runtime-a", {
        baseLatencyMs: 180,
        jitter: {
          kind: "script",
          offsetsMs: [35, -20, 60, 0],
          repeat: true,
        },
        bandwidth: {
          bytesPerSecond: 12_000,
          burstBytes: 1_200,
          maxQueuedFrames: 24,
          maxQueuedBytes: 48_000,
        },
      });
    };

    // A short good burst is not enough to declare recovery. A second outage
    // must keep the original pause stable instead of producing play/pause UI
    // flapping or restoring the high snapshot rate.
    configureNarrowRoute();
    advance(pair, 400, 25);
    pair.bus.configureRoute("runtime-a", "runtime-b", {
      baseLatencyMs: 150,
      loss: { kind: "script", drops: [true], repeat: true },
    });
    advance(pair, 1_250, 25);

    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");
    expect(aPhases.filter((phase) => phase === "playing")).toHaveLength(0);
    expect(bPhases.filter((phase) => phase === "playing")).toHaveLength(0);

    configureNarrowRoute();
    advanceUntil(
      pair,
      () =>
        pair.a.view().phase === "playing" &&
        pair.b.view().phase === "playing",
      12_000,
    );
    advance(pair, 1_000, 25);

    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    // A 25 ms public pump step spans 1.5 simulation ticks; independently
    // committed clocks may therefore be observed one tick apart at the edge
    // of a step while still sharing the same recovered start.
    expect(
      Math.abs(pair.a.view().matchTick - pair.b.view().matchTick),
    ).toBeLessThanOrEqual(1);
    expect(aPhases.filter((phase) => phase === "network-pause")).toHaveLength(1);
    expect(bPhases.filter((phase) => phase === "network-pause")).toHaveLength(1);
    expect(aPhases.filter((phase) => phase === "playing")).toHaveLength(1);
    expect(bPhases.filter((phase) => phase === "playing")).toHaveLength(1);
    expect(pair.a.view().snapshotIntervalTicks).not.toBeNull();
    expect(onAStartCommitted).toHaveBeenCalledTimes(1);
    expect(onBStartCommitted).toHaveBeenCalledTimes(1);
    expect(pair.clock.now() - impairmentStartedAtMs).toBeLessThan(25_000);
  });
});
