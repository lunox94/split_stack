import { describe, expect, it, vi } from "vitest";
import { RULES } from "../../src/config/rules";
import type { MatchResultV1 } from "../../src/domain/types";
import { encodeEnvelope } from "../../src/network/codec";
import { InMemoryRealtimeBus, ManualClock } from "../../src/network/in-memory";
import type { RealtimeEnvelope } from "../../src/network/messages";
import {
  CompetitiveSession,
  type CompetitiveSessionOptions,
} from "../../src/match/competitive-session";

function createPair(overrides: {
  onAForfeitWin?: (playerId: string) => void;
  onABlackout?: (ownerPlayerId: string) => void;
  onAResultConfirmed?: (result: MatchResultV1) => void;
  onBResultConfirmed?: (result: MatchResultV1) => void;
  onADesynchronization?: (reason: string) => void;
} = {}) {
  const bus = new InMemoryRealtimeBus();
  const aClock = new ManualClock(100);
  const bClock = new ManualClock(125);
  const aEndpoint = bus.connect("runtime-a");
  const bEndpoint = bus.connect("runtime-b");
  const common = {
    matchId: "match-1",
    rulesHash: "rules-v1-hash",
  } as const;
  const aOptions: CompetitiveSessionOptions = {
    ...common,
    seat: "a",
    identity: { senderId: "player-a", sessionId: "session-a", displayName: "A" },
    peer: { senderId: "player-b", sessionId: "session-b", displayName: "B" },
    clock: aClock,
    transport: aEndpoint,
    createSeed: () => "00112233445566778899aabbccddeeff",
    ...(overrides.onAForfeitWin === undefined
      ? {}
      : { onForfeitWin: overrides.onAForfeitWin }),
    ...(overrides.onABlackout === undefined
      ? {}
      : { onRemoteBlackout: overrides.onABlackout }),
    ...(overrides.onAResultConfirmed === undefined
      ? {}
      : { onResultConfirmed: overrides.onAResultConfirmed }),
    ...(overrides.onADesynchronization === undefined
      ? {}
      : { onDesynchronization: overrides.onADesynchronization }),
  };
  const bOptions: CompetitiveSessionOptions = {
    ...common,
    seat: "b",
    identity: { senderId: "player-b", sessionId: "session-b", displayName: "B" },
    peer: { senderId: "player-a", sessionId: "session-a", displayName: "A" },
    clock: bClock,
    transport: bEndpoint,
    ...(overrides.onBResultConfirmed === undefined
      ? {}
      : { onResultConfirmed: overrides.onBResultConfirmed }),
  };
  const a = new CompetitiveSession(aOptions);
  const b = new CompetitiveSession(bOptions);
  return { bus, a, b, aClock, bClock, aEndpoint, bEndpoint };
}

function ready(pair: ReturnType<typeof createPair>): void {
  pair.a.start();
  pair.b.start();
  pair.a.setReady(true);
  pair.b.setReady(true);
}

function advanceBoth(
  pair: ReturnType<typeof createPair>,
  milliseconds: number,
  step = 1_000,
): void {
  let remaining = milliseconds;
  while (remaining > 0) {
    const amount = Math.min(step, remaining);
    pair.aClock.advance(amount);
    pair.bClock.advance(amount);
    pair.b.pump();
    pair.a.pump();
    remaining -= amount;
  }
}

describe("CompetitiveSession", () => {
  it("re-sends lobby presence and readiness after the first ephemeral frames are lost", () => {
    const pair = createPair();
    pair.bus.dropNext("runtime-b", "runtime-a", 3);
    ready(pair);
    expect(pair.a.view().phase).toBe("lobby");

    advanceBoth(pair, RULES.network.keepaliveMs);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("coordinates five pings, agrees a seeded config, counts down, and publishes at 10 Hz", () => {
    const pair = createPair();
    ready(pair);

    const aCountdown = pair.a.view();
    const bCountdown = pair.b.view();
    expect(aCountdown.phase).toBe("countdown");
    expect(bCountdown.phase).toBe("countdown");
    expect(aCountdown.configHash).toBe(bCountdown.configHash);
    expect(aCountdown.seed).toBe("00112233445566778899aabbccddeeff");
    expect(aCountdown.clockSampleIds).toHaveLength(3);
    expect(bCountdown.clockOffsetMs).toBe(25);
    expect(aCountdown.countdownTicks).toBe(RULES.network.resumeCountdownTicks);

    advanceBoth(pair, 3_000);
    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    expect(pair.a.view().matchTick).toBe(0);

    advanceBoth(pair, 600, 100);
    expect(pair.a.view().matchTick).toBe(36);
    expect(pair.b.view().remote?.stateTick).toBe(36);
    expect(pair.a.view().remote?.stateTick).toBe(36);
    // Tick 0 plus ticks 6, 12, 18, 24, 30, and 36.
    expect(pair.a.view().remote?.snapshotSeq).toBe(7);
  });

  it("retries a missing clock sample during the initial handshake", () => {
    const pair = createPair();
    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    pair.bus.delayNext("runtime-b", "runtime-a");
    pair.b.setReady(true);
    pair.bus.dropNext("runtime-b", "runtime-a");
    pair.bus.releaseDelayed();

    expect(pair.a.view().phase).toBe("synchronizing");
    expect(pair.a.view().clockSampleIds).toHaveLength(0);

    advanceBoth(pair, RULES.network.retryMs);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    expect(pair.a.view().clockSampleIds).toHaveLength(3);
  });

  it("ends neutrally when the initial clock handshake cannot recover", () => {
    const onDesynchronization = vi.fn<(reason: string) => void>();
    const pair = createPair({ onADesynchronization: onDesynchronization });
    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    pair.bus.delayNext("runtime-b", "runtime-a");
    pair.b.setReady(true);
    pair.bus.dropNext("runtime-b", "runtime-a");
    pair.bus.releaseDelayed();
    pair.b.disconnect();

    advanceBoth(pair, RULES.network.missingPeerMs);

    expect(pair.a.view().phase).toBe("desynchronized");
    expect(onDesynchronization).toHaveBeenCalledWith("clock-sync-timeout");
  });

  it("retries a missing clock commit before accepting the match config", () => {
    const pair = createPair();
    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    pair.bus.delayNext("runtime-b", "runtime-a");
    pair.b.setReady(true);
    pair.bus.delayNext("runtime-b", "runtime-a", 5);
    pair.bus.releaseDelayed();
    pair.bus.dropNext("runtime-a", "runtime-b");
    pair.bus.releaseDelayed();

    advanceBoth(pair, RULES.network.retryMs);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    expect(pair.b.view().clockOffsetMs).toBe(25);
  });

  it("retries a missing config acknowledgement during the initial handshake", () => {
    const pair = createPair();
    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    pair.bus.delayNext("runtime-b", "runtime-a");
    pair.b.setReady(true);
    pair.bus.delayNext("runtime-b", "runtime-a", 6);
    pair.bus.releaseDelayed();
    pair.bus.releaseDelayed();

    expect(pair.a.view().phase).toBe("synchronizing");
    expect(pair.a.view().configHash).toBe(pair.b.view().configHash);

    advanceBoth(pair, RULES.network.retryMs);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("ends neutrally when config acknowledgement retries cannot recover", () => {
    const onDesynchronization = vi.fn<(reason: string) => void>();
    const pair = createPair({ onADesynchronization: onDesynchronization });
    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    pair.bus.delayNext("runtime-b", "runtime-a");
    pair.b.setReady(true);
    pair.bus.delayNext("runtime-b", "runtime-a", 6);
    pair.bus.releaseDelayed();
    pair.bus.releaseDelayed();
    pair.b.disconnect();

    advanceBoth(pair, RULES.network.missingPeerMs);

    expect(pair.a.view().phase).toBe("desynchronized");
    expect(onDesynchronization).toHaveBeenCalledWith("config-ack-timeout");
  });

  it("does not allow readiness changes to move a live match back to the lobby", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000);

    pair.a.setReady(false);

    expect(pair.a.view().phase).toBe("playing");
    expect(pair.a.view().localReady).toBe(true);
  });

  it("preserves a version mismatch after bounded rejection retries", () => {
    const pair = createPair();
    pair.a.start();
    pair.b.start();
    pair.aEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-a",
        sessionId: "session-a",
        kind: "MATCH_CONFIG",
        seq: 1,
        matchTick: 0,
        sentAtMonotonicMs: pair.aClock.now(),
        payload: {
          eventId: "a:bad-config",
          rulesVersion: 1,
          rulesHash: "incompatible-rules",
          configHash: "bad-config-hash",
          seed: "00112233445566778899aabbccddeeff",
          coordinatorPlayerId: "player-a",
          seatAPlayerId: "player-a",
          seatBPlayerId: "player-b",
        },
      }),
    );
    expect(pair.b.view().phase).toBe("version-mismatch");

    advanceBoth(pair, RULES.network.missingPeerMs);

    expect(pair.b.view().phase).toBe("version-mismatch");
  });

  it("routes ordered critical effects into the local simulation and UI callbacks", () => {
    const onBlackout = vi.fn();
    const pair = createPair({ onABlackout: onBlackout });
    ready(pair);
    advanceBoth(pair, 3_000);

    const sendFromB = (envelope: RealtimeEnvelope): void => {
      pair.bEndpoint.send(encodeEnvelope(envelope));
    };
    const base = {
      protocol: 1,
      matchId: "match-1",
      senderId: "player-b",
      sessionId: "session-b",
      matchTick: 0,
      sentAtMonotonicMs: pair.bClock.now(),
    } as const;
    sendFromB({
      ...base,
      kind: "GARBAGE_ATTACK",
      seq: 1,
      payload: { eventId: "b:garbage:1", targetPlayerId: "player-a", rows: 2 },
    });
    sendFromB({
      ...base,
      kind: "SCRAMBLE_START",
      seq: 2,
      payload: { eventId: "b:scramble:1", targetPlayerId: "player-a" },
    });
    sendFromB({
      ...base,
      kind: "BLACKOUT_START",
      seq: 3,
      payload: { eventId: "b:blackout:1", ownerPlayerId: "player-b" },
    });

    const local = pair.a.view().local;
    expect(local?.player.incomingGarbage).toHaveLength(1);
    expect(local?.player.incomingGarbage[0]?.rows).toBe(2);
    expect(local?.player.statuses).toContainEqual({
      kind: "scramble",
      remainingTicks: RULES.power.scrambleTicks,
    });
    expect(onBlackout).toHaveBeenCalledWith("player-b", "b:blackout:1");
  });

  it("measures garbage warning from the attack's shared match tick", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 5_000);
    expect(pair.a.view().matchTick).toBe(120);

    pair.bEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-b",
        sessionId: "session-b",
        kind: "GARBAGE_ATTACK",
        seq: 1,
        matchTick: 10,
        sentAtMonotonicMs: pair.bClock.now(),
        payload: {
          eventId: "b:garbage:delayed",
          targetPlayerId: "player-a",
          rows: 2,
        },
      }),
    );

    expect(pair.a.view().local?.player.incomingGarbage[0]?.readyTick).toBe(160);
  });

  it("stops neutrally instead of advancing through an implausible remote target tick", () => {
    const onDesynchronization = vi.fn<(reason: string) => void>();
    const onResult = vi.fn<(result: MatchResultV1) => void>();
    const pair = createPair({
      onADesynchronization: onDesynchronization,
      onAResultConfirmed: onResult,
    });
    ready(pair);
    advanceBoth(pair, 3_000);
    const localTick = pair.a.view().matchTick;
    const remoteTick = localTick +
      Math.ceil(
        (RULES.network.missingPeerMs * RULES.timing.ticksPerSecond) / 1_000,
      ) +
      1;

    pair.bEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-b",
        sessionId: "session-b",
        kind: "NETWORK_PAUSE",
        seq: 1,
        matchTick: remoteTick,
        sentAtMonotonicMs: pair.bClock.now(),
        payload: {
          eventId: "b:network-pause:implausible",
          pauseEpoch: 1,
          proposedPauseTick: remoteTick,
        },
      }),
    );

    expect(pair.a.view().phase).toBe("desynchronized");
    expect(pair.a.view().matchTick).toBe(localTick);
    expect(onDesynchronization).toHaveBeenCalledWith("remote-tick-out-of-range");
    expect(pair.a.view().terminal).toMatchObject({
      outcome: "desync",
      reason: "desynchronization",
    });
    expect(pair.a.view().result).toMatchObject({
      schema: "split-stack/result/v1",
      matchId: "match-1",
      outcome: "desync",
      reason: "desynchronization",
      durationTicks: 0,
      finalLevel: 1,
      completedBy: "player-a",
      statsByPlayer: {
        "player-a": { score: 0, lines: 0 },
        "player-b": { score: 0, lines: 0 },
      },
    });
    expect(onResult).toHaveBeenCalledOnce();
  });

  it("rejects an out-of-range remote restart instead of scheduling a huge tick", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000);
    const remoteTick =
      pair.b.view().matchTick +
      Math.ceil(
        (RULES.network.missingPeerMs * RULES.timing.ticksPerSecond) / 1_000,
      ) +
      1;

    pair.aEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-a",
        sessionId: "session-a",
        kind: "START",
        seq: 3,
        matchTick: remoteTick,
        sentAtMonotonicMs: pair.aClock.now(),
        payload: {
          eventId: "a:unexpected-restart",
          epoch: 0,
          startAtCoordinatorMs: pair.aClock.now() + 3_000,
          startTick: remoteTick,
          configHash: pair.a.view().configHash!,
        },
      }),
    );

    expect(pair.b.view().phase).toBe("desynchronized");
    expect(pair.b.view().matchTick).toBe(0);
    expect(pair.b.view().result).toMatchObject({ outcome: "desync" });
  });

  it("stops neutrally when a top-out contradicts its terminal snapshot hash", () => {
    const onDesynchronization = vi.fn<(reason: string) => void>();
    const onResult = vi.fn<(result: MatchResultV1) => void>();
    const pair = createPair({
      onADesynchronization: onDesynchronization,
      onAResultConfirmed: onResult,
    });
    ready(pair);
    advanceBoth(pair, 3_000);
    const remote = pair.a.view().remote!;

    pair.bEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-b",
        sessionId: "session-b",
        kind: "TOP_OUT",
        seq: 1,
        matchTick: remote.stateTick,
        sentAtMonotonicMs: pair.bClock.now(),
        payload: {
          eventId: "b:top-out:bad-hash",
          playerId: "player-b",
          reason: "spawn-collision",
          stateHash: (remote.stateHash ^ 1) >>> 0,
          finalLevel: 1,
          finalStats: {
            score: 0,
            lines: 0,
            garbageSent: 0,
            powersActivated: 0,
            tetrises: 0,
            tSpinSingles: 0,
            tSpinDoubles: 0,
            tSpinTriples: 0,
            topOutTick: remote.stateTick,
          },
        },
      }),
    );

    expect(pair.a.view().phase).toBe("desynchronized");
    expect(pair.a.view().result).toMatchObject({
      outcome: "desync",
      reason: "desynchronization",
    });
    expect(onDesynchronization).toHaveBeenCalledWith(
      "top-out-state-hash-mismatch",
    );
    expect(onResult).toHaveBeenCalledOnce();
  });

  it("exchanges identical result confirmations and lets only Seat A publish a normal result", () => {
    const onAResult = vi.fn<(result: MatchResultV1) => void>();
    const onBResult = vi.fn<(result: MatchResultV1) => void>();
    const pair = createPair({
      onAResultConfirmed: onAResult,
      onBResultConfirmed: onBResult,
    });
    ready(pair);
    advanceBoth(pair, 3_000);

    for (let piece = 0; piece < 200 && pair.a.view().phase === "playing"; piece += 1) {
      pair.a.dispatch("hard-drop");
    }
    expect(pair.a.view()).toMatchObject({
      phase: "finished",
      terminal: {
        outcome: "peer-win",
        reason: "top-out",
        localTopOutTick: 0,
        peerTopOutTick: null,
      },
    });
    expect(pair.b.view().terminal).toMatchObject({
      outcome: "local-win",
      peerTopOutTick: 0,
    });

    advanceBoth(pair, RULES.network.retryMs);

    expect(onAResult).toHaveBeenCalledTimes(1);
    expect(onBResult).not.toHaveBeenCalled();
    expect(pair.a.view().result).toEqual(pair.b.view().result);
    expect(pair.a.view().result).toMatchObject({
      schema: "split-stack/result/v1",
      matchId: "match-1",
      players: [
        { id: "player-a", displayName: "A" },
        { id: "player-b", displayName: "B" },
      ],
      outcome: "seat-b",
      reason: "top-out",
      durationTicks: 0,
      finalLevel: 1,
      completedBy: "player-a",
      statsByPlayer: {
        "player-a": { topOutTick: 0 },
        "player-b": { score: 0, lines: 0 },
      },
    });
    expect(pair.a.view().result?.seedHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("retries a dropped result confirmation before Seat A publishes", () => {
    const onAResult = vi.fn<(result: MatchResultV1) => void>();
    const pair = createPair({ onAResultConfirmed: onAResult });
    ready(pair);
    advanceBoth(pair, 3_000);

    for (let piece = 0; piece < 200 && pair.a.view().phase === "playing"; piece += 1) {
      pair.a.dispatch("hard-drop");
    }
    pair.bus.dropNext("runtime-b", "runtime-a");
    advanceBoth(pair, RULES.network.retryMs);
    expect(onAResult).not.toHaveBeenCalled();

    advanceBoth(pair, RULES.network.retryMs);
    expect(onAResult).toHaveBeenCalledTimes(1);
  });

  it("finishes neutrally when top-out result consensus cannot recover", () => {
    const onAResult = vi.fn<(result: MatchResultV1) => void>();
    const onDesynchronization = vi.fn<(reason: string) => void>();
    const pair = createPair({
      onAResultConfirmed: onAResult,
      onADesynchronization: onDesynchronization,
    });
    ready(pair);
    advanceBoth(pair, 3_000);

    for (let piece = 0; piece < 200 && pair.a.view().phase === "playing"; piece += 1) {
      pair.a.dispatch("hard-drop");
    }
    pair.b.disconnect();

    advanceBoth(pair, RULES.network.reconnectGraceMs);

    expect(pair.a.view().phase).toBe("desynchronized");
    expect(pair.a.view().result).toMatchObject({
      outcome: "desync",
      reason: "desynchronization",
    });
    expect(onDesynchronization).toHaveBeenCalledWith("result-consensus-timeout");
    expect(onAResult).toHaveBeenCalledOnce();
  });

  it("settles simultaneous top-outs at the same tick as one confirmed draw", () => {
    const onAResult = vi.fn<(result: MatchResultV1) => void>();
    const pair = createPair({ onAResultConfirmed: onAResult });
    ready(pair);
    advanceBoth(pair, 3_000);

    // Hold each final snapshot and TOP_OUT until both local simulations have
    // independently reached their terminal state at tick zero.
    pair.bus.delayNext("runtime-a", "runtime-b", 2);
    pair.bus.delayNext("runtime-b", "runtime-a", 2);
    for (let piece = 0; piece < 200 && pair.a.view().phase === "playing"; piece += 1) {
      pair.a.dispatch("hard-drop");
    }
    for (let piece = 0; piece < 200 && pair.b.view().phase === "playing"; piece += 1) {
      pair.b.dispatch("hard-drop");
    }
    pair.bus.releaseDelayed();

    expect(pair.a.view().terminal).toMatchObject({
      outcome: "draw",
      localTopOutTick: 0,
      peerTopOutTick: 0,
    });
    expect(pair.b.view().terminal).toMatchObject({
      outcome: "draw",
      localTopOutTick: 0,
      peerTopOutTick: 0,
    });

    advanceBoth(pair, RULES.network.retryMs);
    expect(onAResult).toHaveBeenCalledTimes(1);
    expect(pair.a.view().result).toEqual(pair.b.view().result);
    expect(pair.a.view().result).toMatchObject({
      outcome: "draw",
      reason: "simultaneous",
      durationTicks: 0,
    });
  });

  it("rolls local stats back when an earlier peer top-out arrives late", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 4_000);
    const canonical = pair.a.view().local;
    expect(canonical?.tick).toBe(60);

    advanceBoth(pair, 1_000);
    pair.a.dispatch("hard-drop");
    expect(pair.a.view().local?.player.score).toBeGreaterThan(canonical!.player.score);

    pair.bEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-b",
        sessionId: "session-b",
        kind: "TOP_OUT",
        seq: 1,
        matchTick: 60,
        sentAtMonotonicMs: pair.bClock.now(),
        payload: {
          eventId: "b:top-out:60",
          playerId: "player-b",
          reason: "spawn-collision",
          stateHash: 1,
          finalLevel: 1,
          finalStats: {
            score: 0,
            lines: 0,
            garbageSent: 0,
            powersActivated: 0,
            tetrises: 0,
            tSpinSingles: 0,
            tSpinDoubles: 0,
            tSpinTriples: 0,
            topOutTick: 60,
          },
        },
      }),
    );

    expect(pair.a.view().phase).toBe("finished");
    expect(pair.a.view().terminal).toMatchObject({
      outcome: "local-win",
      localTopOutTick: null,
      peerTopOutTick: 60,
    });
    expect(pair.a.view().local).toMatchObject({
      tick: 60,
      player: {
        score: canonical!.player.score,
        lines: canonical!.player.lines,
        stats: canonical!.player.stats,
      },
    });
  });

  it("adopts an initiating peer's pause epoch and resumes after visibility returns", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    const frozenTick = pair.a.view().matchTick;

    pair.a.setHidden(true);
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");

    pair.a.setHidden(false);
    pair.b.setHidden(false);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    advanceBoth(pair, 3_000);
    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    expect(pair.a.view().matchTick).toBe(frozenTick);
    expect(pair.b.view().matchTick).toBe(frozenTick);
  });

  it("freezes after a missing keepalive and resumes after state exchange and a fresh countdown", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    expect(pair.a.view().matchTick).toBe(36);

    pair.b.disconnect();
    advanceBoth(pair, RULES.network.missingPeerMs, 1_000);
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");
    const frozenTick = pair.a.view().matchTick;

    const replacement = pair.bus.connect("runtime-b-returned");
    pair.b.attachTransport(replacement);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");

    advanceBoth(pair, 3_000, 1_000);
    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    expect(pair.a.view().matchTick).toBe(frozenTick);
    expect(pair.b.view().matchTick).toBe(frozenTick);
  });

  it("awards a forfeit once after the full reconnect grace", () => {
    const onForfeitWin = vi.fn();
    const onAResult = vi.fn<(result: MatchResultV1) => void>();
    const pair = createPair({
      onAForfeitWin: onForfeitWin,
      onAResultConfirmed: onAResult,
    });
    ready(pair);
    advanceBoth(pair, 3_000);
    pair.b.disconnect();

    advanceBoth(pair, RULES.network.missingPeerMs);
    pair.aClock.advance(RULES.network.reconnectGraceMs - 1);
    pair.a.pump();
    expect(onForfeitWin).not.toHaveBeenCalled();

    pair.aClock.advance(1);
    pair.a.pump();
    pair.a.pump();
    expect(onForfeitWin).toHaveBeenCalledTimes(1);
    expect(onForfeitWin).toHaveBeenCalledWith("player-b");
    expect(pair.a.view().phase).toBe("finished");
    expect(onAResult).toHaveBeenCalledTimes(1);
    expect(onAResult).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "seat-a",
        reason: "forfeit",
        completedBy: "player-a",
      }),
    );
  });

  it("allows Seat B to publish alone when Seat A exhausts reconnect grace", () => {
    const onAResult = vi.fn<(result: MatchResultV1) => void>();
    const onBResult = vi.fn<(result: MatchResultV1) => void>();
    const pair = createPair({
      onAResultConfirmed: onAResult,
      onBResultConfirmed: onBResult,
    });
    ready(pair);
    advanceBoth(pair, 3_000);
    pair.a.disconnect();

    advanceBoth(pair, RULES.network.missingPeerMs);
    pair.bClock.advance(RULES.network.reconnectGraceMs);
    pair.b.pump();

    expect(onAResult).not.toHaveBeenCalled();
    expect(onBResult).toHaveBeenCalledTimes(1);
    expect(onBResult).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "seat-b",
        reason: "forfeit",
        completedBy: "player-b",
      }),
    );
  });
});
