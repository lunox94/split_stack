import { describe, expect, it, vi } from "vitest";
import { RULES } from "../../src/config/rules";
import { clearLines, findCompleteLines, mergePiece } from "../../src/domain/board";
import { collides } from "../../src/domain/collision";
import { getGhostY } from "../../src/domain/movement";
import type { MatchResultV1 } from "../../src/domain/types";
import type { ActivePiece, Grid, Rotation } from "../../src/domain/types";
import type { SimulationEffect } from "../../src/domain/simulation";
import { decodeEnvelope, encodeEnvelope } from "../../src/network/codec";
import { NetworkDiagnostics } from "../../src/network/diagnostics";
import { InMemoryRealtimeBus, ManualClock } from "../../src/network/in-memory";
import type { RealtimeEnvelope } from "../../src/network/messages";
import {
  CompetitiveSession,
  type CompetitiveIncomingAttackKind,
  type CompetitiveSessionOptions,
} from "../../src/match/competitive-session";

function createPair(overrides: {
  onAForfeitWin?: (playerId: string) => void;
  onABlackout?: (ownerPlayerId: string) => void;
  onAIncomingGarbage?: (rows: number, eventId: string) => void;
  onAIncomingAttack?: (
    kind: CompetitiveIncomingAttackKind,
    eventId: string,
    value?: number,
  ) => void;
  onASimulationEffects?: (effects: readonly SimulationEffect[]) => void;
  onAResultConfirmed?: (result: MatchResultV1) => void;
  onBResultConfirmed?: (result: MatchResultV1) => void;
  onADesynchronization?: (reason: string) => void;
  onATransportRecoveryNeeded?: () => boolean | void;
  onBTransportRecoveryNeeded?: () => boolean | void;
  aDiagnostics?: NetworkDiagnostics;
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
    ...(overrides.onAIncomingGarbage === undefined
      ? {}
      : { onIncomingGarbage: overrides.onAIncomingGarbage }),
    ...(overrides.onAIncomingAttack === undefined
      ? {}
      : { onIncomingAttack: overrides.onAIncomingAttack }),
    ...(overrides.onASimulationEffects === undefined
      ? {}
      : { onSimulationEffects: overrides.onASimulationEffects }),
    ...(overrides.onAResultConfirmed === undefined
      ? {}
      : { onResultConfirmed: overrides.onAResultConfirmed }),
    ...(overrides.onADesynchronization === undefined
      ? {}
      : { onDesynchronization: overrides.onADesynchronization }),
    ...(overrides.onATransportRecoveryNeeded === undefined
      ? {}
      : { onTransportRecoveryNeeded: overrides.onATransportRecoveryNeeded }),
    ...(overrides.aDiagnostics === undefined
      ? {}
      : { diagnostics: overrides.aDiagnostics }),
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
    ...(overrides.onBTransportRecoveryNeeded === undefined
      ? {}
      : { onTransportRecoveryNeeded: overrides.onBTransportRecoveryNeeded }),
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

function placementScore(grid: Grid): number {
  const completed = findCompleteLines(grid);
  const settled = clearLines(grid, completed);
  const heights: number[] = [];
  let holes = 0;
  for (let column = 0; column < RULES.board.width; column += 1) {
    let firstOccupied = settled.length;
    for (let row = 0; row < settled.length; row += 1) {
      if (settled[row]?.[column] !== null) {
        firstOccupied = Math.min(firstOccupied, row);
      } else if (firstOccupied < settled.length) {
        holes += 1;
      }
    }
    heights.push(settled.length - firstOccupied);
  }
  const aggregateHeight = heights.reduce((sum, height) => sum + height, 0);
  const maximumHeight = Math.max(0, ...heights);
  const bumpiness = heights.slice(1).reduce(
    (sum, height, index) => sum + Math.abs(height - (heights[index] ?? 0)),
    0,
  );
  return (
    completed.length * 1_000 -
    holes * 120 -
    aggregateHeight * 4 -
    maximumHeight * 12 -
    bumpiness * 6
  );
}

function steerCurrentPiece(session: CompetitiveSession): void {
  const snapshot = session.view().local;
  const active = snapshot?.player.active;
  if (
    snapshot === undefined ||
    active == null ||
    active.descriptor.shape === "acid" ||
    snapshot.resolution !== null
  ) {
    return;
  }
  let best: { rotation: Rotation; x: number; score: number } | undefined;
  for (const rotation of [0, 1, 2, 3] as const) {
    for (let x = -4; x < RULES.board.width + 4; x += 1) {
      const candidate: ActivePiece = { ...active, rotation, x };
      if (collides(snapshot.player.grid, candidate)) continue;
      const landing: ActivePiece = {
        ...candidate,
        y: getGhostY(snapshot.player.grid, candidate),
      };
      const score = placementScore(mergePiece(snapshot.player.grid, landing));
      if (best === undefined || score > best.score) best = { rotation, x, score };
    }
  }
  if (best === undefined) return;
  const turns = (best.rotation - active.rotation + 4) % 4;
  for (let turn = 0; turn < turns; turn += 1) session.dispatch("rotate-cw");
  const rotatedX = session.view().local?.player.active?.x ?? active.x;
  const direction = best.x < rotatedX ? "move-left" : "move-right";
  for (let move = 0; move < Math.abs(best.x - rotatedX); move += 1) {
    session.dispatch(direction);
  }
}

describe("CompetitiveSession", () => {
  it("re-sends lobby presence and readiness after the first ephemeral frames are lost", () => {
    const pair = createPair();
    pair.bus.dropNext("runtime-b", "runtime-a", 5);
    ready(pair);
    expect(pair.a.view().phase).toBe("lobby");

    advanceBoth(pair, RULES.network.keepaliveMs);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("returns to the lobby after a pre-match visibility interruption and can still ready", () => {
    const pair = createPair();
    pair.a.start();
    pair.b.start();

    pair.a.setHidden(true);
    expect(pair.a.view().phase).toBe("network-pause");

    pair.a.setHidden(false);
    expect(pair.a.view().phase).toBe("lobby");

    pair.a.setReady(true);
    pair.b.setReady(true);

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
    expect(aCountdown.resuming).toBe(false);
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
          rulesVersion: RULES.rulesVersion,
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
    const onIncomingGarbage = vi.fn();
    const onIncomingAttack = vi.fn();
    const pair = createPair({
      onABlackout: onBlackout,
      onAIncomingGarbage: onIncomingGarbage,
      onAIncomingAttack: onIncomingAttack,
    });
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
    sendFromB({
      ...base,
      kind: "HOLLOW_CROSS",
      seq: 4,
      payload: { eventId: "b:cross:1", targetPlayerId: "player-a" },
    });
    sendFromB({
      ...base,
      kind: "GLITCH_PIECE",
      seq: 5,
      payload: { eventId: "b:glitch:1", targetPlayerId: "player-a" },
    });

    const local = pair.a.view().local;
    expect(local?.player.incomingGarbage).toHaveLength(1);
    expect(local?.player.incomingGarbage[0]?.rows).toBe(2);
    expect(local?.player.statuses).toContainEqual({
      kind: "scramble",
      remainingTicks: RULES.power.scrambleTicks,
    });
    expect(onBlackout).toHaveBeenCalledWith("player-b", "b:blackout:1");
    expect(onIncomingGarbage).toHaveBeenCalledWith(2, "b:garbage:1");
    expect(onIncomingAttack.mock.calls).toEqual([
      ["garbage", "b:garbage:1", 2],
      ["scramble", "b:scramble:1"],
      ["blackout", "b:blackout:1"],
      ["hollow-cross", "b:cross:1"],
      ["glitch", "b:glitch:1"],
    ]);
  });

  it("reports effects produced by automatic simulation ticks", () => {
    const onEffects = vi.fn<(effects: readonly SimulationEffect[]) => void>();
    const pair = createPair({ onASimulationEffects: onEffects });
    ready(pair);
    advanceBoth(pair, 3_000);

    advanceBoth(pair, 17_500, 100);

    expect(onEffects.mock.calls.flatMap(([effects]) => effects)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "piece-locked" })]),
    );
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
          connectionIssue: true,
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

    advanceBoth(pair, RULES.network.resultConsensusMs);

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

  it("does not declare connection loss while a hidden client still receives peer traffic", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    const frozenTick = pair.a.view().matchTick;

    pair.a.setHidden(true);
    advanceBoth(pair, RULES.network.reconnectGraceMs + 1_000, 1_000);

    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      matchTick: frozenTick,
      connectionStatus: "unstable",
    });
    expect(pair.a.view().terminal).toBeUndefined();

    pair.a.setHidden(false);
    expect(pair.a.view().phase).toBe("countdown");
  });

  it("waits for Seat B to become visible before coordinating resume", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    pair.b.setHidden(true);
    advanceBoth(pair, RULES.network.keepaliveMs * 2, 100);

    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");

    pair.b.setHidden(false);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("releases a replacement whose listener fails and accepts a later transport", () => {
    const pair = createPair();
    const leave = vi.fn<() => void>();
    const rejectedReplacement = {
      setListener: () => {
        throw new Error("realtime listener already exists");
      },
      send: vi.fn<(data: Uint8Array) => void>(),
      leave,
    };

    pair.a.disconnect();
    expect(() => pair.a.attachTransport(rejectedReplacement)).toThrow(
      "realtime listener already exists",
    );
    expect(leave).toHaveBeenCalledTimes(1);

    const workingReplacement = pair.bus.connect("runtime-a-after-listener-error");
    expect(() => pair.a.attachTransport(workingReplacement)).not.toThrow();
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

  it("rolls the later pause back to a common checkpoint before the resume countdown", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 4_000, 100);
    expect(pair.a.view().matchTick).toBe(60);
    expect(pair.b.view().matchTick).toBe(60);

    pair.b.disconnect();
    pair.a.setHidden(true);
    pair.aClock.advance(1_000);
    pair.bClock.advance(1_000);
    pair.b.pump();
    expect(pair.b.view().matchTick).toBe(120);
    pair.b.setHidden(true);
    pair.a.setHidden(false);
    pair.b.setHidden(false);

    const replacement = pair.bus.connect("runtime-b-rollback");
    pair.b.attachTransport(replacement);
    advanceBoth(pair, RULES.network.retryMs, RULES.network.retryMs);

    expect(pair.a.view()).toMatchObject({
      phase: "countdown",
      matchTick: 60,
      resuming: true,
    });
    expect(pair.b.view()).toMatchObject({
      phase: "countdown",
      matchTick: 60,
      resuming: true,
    });
    expect(pair.a.view().countdownTicks).toBe(RULES.network.resumeCountdownTicks);

    advanceBoth(pair, 3_000, 100);
    expect(pair.a.view()).toMatchObject({ phase: "playing", matchTick: 60 });
    expect(pair.b.view()).toMatchObject({ phase: "playing", matchTick: 60 });
  });

  it("checks liveness before fast-forwarding after a long foreground stall", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 4_000, 100);
    const stalledTick = pair.a.view().matchTick;
    const heldPeerTraffic = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      () => true,
    );

    for (let elapsed = 0; elapsed < 6_500; elapsed += 100) {
      pair.aClock.advance(100);
      pair.bClock.advance(100);
      pair.b.pump();
    }
    expect(pair.b.view().phase).toBe("network-pause");

    // Re-open delivery without replaying stale traffic. The first outbound
    // frame from A will synchronously provoke B, so this catches any liveness
    // check that occurs after outbound work begins.
    pair.bus.discardHeld(heldPeerTraffic);
    pair.a.pump();

    expect(pair.a.view()).toMatchObject({
      phase: "countdown",
      matchTick: stalledTick,
    });
    expect(pair.b.view()).toMatchObject({
      phase: "countdown",
      matchTick: stalledTick,
    });
    expect(pair.a.view().remote?.stateTick).toBe(stalledTick);
    expect(pair.b.view().remote?.stateTick).toBe(stalledTick);
  });

  it("buffers ordered attacks received during pause until the common checkpoint is final", () => {
    const onIncomingAttack = vi.fn();
    const pair = createPair({ onAIncomingAttack: onIncomingAttack });
    ready(pair);
    advanceBoth(pair, 3_000, 100);
    const heldKinds = new Set<string>();
    const gameplayKinds = new Set([
      "GARBAGE_ATTACK",
      "HOLLOW_CROSS",
      "GLITCH_PIECE",
      "SCRAMBLE_START",
      "BLACKOUT_START",
    ]);
    const holdId = pair.bus.holdMatching("runtime-b", "runtime-a", (data) => {
      const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
      if (!decoded.ok || !gameplayKinds.has(decoded.value.kind)) return false;
      heldKinds.add(decoded.value.kind);
      return true;
    });

    for (
      let piece = 0;
      piece < 180 &&
      (!heldKinds.has("GARBAGE_ATTACK") ||
        !["HOLLOW_CROSS", "GLITCH_PIECE", "SCRAMBLE_START"].some((kind) =>
          heldKinds.has(kind),
        ));
      piece += 1
    ) {
      steerCurrentPiece(pair.a);
      steerCurrentPiece(pair.b);
      pair.b.dispatch("hard-drop");
      advanceBoth(pair, 500, 50);
      expect(pair.b.view().phase).toBe("playing");
    }
    expect(heldKinds.has("GARBAGE_ATTACK")).toBe(true);
    expect(
      ["HOLLOW_CROSS", "GLITCH_PIECE", "SCRAMBLE_START"].some((kind) =>
        heldKinds.has(kind),
      ),
    ).toBe(true);

    const before = pair.a.view().local!.player;
    pair.a.setHidden(true);
    expect(pair.a.view().phase).toBe("network-pause");
    pair.bus.releaseHeld(holdId);

    expect(onIncomingAttack).not.toHaveBeenCalled();
    expect(pair.a.view().local?.player.incomingGarbage).toEqual(
      before.incomingGarbage,
    );
    expect(pair.a.view().local?.player.forcedQueue).toEqual(before.forcedQueue);
    expect(pair.a.view().local?.player.statuses).toEqual(before.statuses);

    pair.a.setHidden(false);
    expect(pair.a.view().phase).toBe("countdown");
    const resumed = pair.a.view().local!.player;
    expect(resumed.incomingGarbage.length).toBeGreaterThan(
      before.incomingGarbage.length,
    );
    expect(
      resumed.statuses.some((status) => status.kind === "scramble") ||
        resumed.forcedQueue.some(
          (descriptor) =>
            descriptor.source === "cross" || descriptor.source === "glitch",
        ),
    ).toBe(true);
    expect(onIncomingAttack).toHaveBeenCalled();
  });

  it("discards attacks generated in the rolled-back tail without replaying their semantic event", () => {
    const onIncomingAttack = vi.fn();
    const pair = createPair({ onAIncomingAttack: onIncomingAttack });
    ready(pair);
    advanceBoth(pair, 4_000, 100);
    const commonTick = pair.a.view().matchTick;
    const gameplayKinds = new Set([
      "GARBAGE_ATTACK",
      "HOLLOW_CROSS",
      "GLITCH_PIECE",
      "SCRAMBLE_START",
      "BLACKOUT_START",
    ]);
    let heldGameplay = 0;
    const pauseHold = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "NETWORK_PAUSE";
      },
    );
    const gameplayHold = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (!decoded.ok || !gameplayKinds.has(decoded.value.kind)) return false;
        heldGameplay += 1;
        expect(decoded.value.matchTick).toBeGreaterThan(commonTick);
        return true;
      },
    );

    pair.a.setHidden(true);
    for (let piece = 0; piece < 180 && heldGameplay === 0; piece += 1) {
      steerCurrentPiece(pair.b);
      pair.b.dispatch("hard-drop");
      advanceBoth(pair, 100, 50);
      expect(pair.b.view().phase).toBe("playing");
    }
    expect(heldGameplay).toBeGreaterThan(0);

    const before = pair.a.view().local!.player;
    pair.bus.releaseHeld(pauseHold);
    expect(pair.b.view()).toMatchObject({
      phase: "network-pause",
      matchTick: commonTick,
    });
    pair.bus.releaseHeld(gameplayHold);
    expect(onIncomingAttack).not.toHaveBeenCalled();

    pair.a.setHidden(false);
    expect(pair.a.view()).toMatchObject({ phase: "countdown", matchTick: commonTick });
    expect(pair.b.view()).toMatchObject({ phase: "countdown", matchTick: commonTick });
    expect(pair.a.view().remote?.stateTick).toBe(commonTick);
    expect(pair.b.view().remote?.stateTick).toBe(commonTick);
    expect(pair.a.view().local?.player.incomingGarbage).toEqual(
      before.incomingGarbage,
    );
    expect(pair.a.view().local?.player.forcedQueue).toEqual(before.forcedQueue);
    expect(pair.a.view().local?.player.statuses).toEqual(before.statuses);

    advanceBoth(pair, RULES.network.retryMs * 2, RULES.network.retryMs);
    expect(onIncomingAttack).not.toHaveBeenCalled();
  });

  it("keeps a future-source attack pending and discards it when the common tick is earlier", () => {
    const onIncomingAttack = vi.fn();
    const pair = createPair({ onAIncomingAttack: onIncomingAttack });
    ready(pair);
    advanceBoth(pair, 4_000, 100);
    const heldTicks: number[] = [];
    const gameplayKinds = new Set([
      "GARBAGE_ATTACK",
      "HOLLOW_CROSS",
      "GLITCH_PIECE",
      "SCRAMBLE_START",
      "BLACKOUT_START",
    ]);
    const gameplayHold = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (!decoded.ok || !gameplayKinds.has(decoded.value.kind)) return false;
        heldTicks.push(decoded.value.matchTick);
        return true;
      },
    );

    for (let piece = 0; piece < 180 && heldTicks.length === 0; piece += 1) {
      pair.bClock.advance(100);
      pair.aEndpoint.send(
        encodeEnvelope({
          protocol: 1,
          matchId: "match-1",
          senderId: "player-a",
          sessionId: "session-a",
          kind: "READY",
          matchTick: pair.a.view().matchTick,
          sentAtMonotonicMs: pair.aClock.now(),
          payload: { ready: true, rulesHash: "rules-v1-hash" },
        }),
      );
      pair.b.pump();
      steerCurrentPiece(pair.b);
      pair.b.dispatch("hard-drop");
      expect(pair.b.view().phase).toBe("playing");
    }
    expect(heldTicks.length).toBeGreaterThan(0);
    const firstSourceTick = Math.min(...heldTicks);
    const commonTick = firstSourceTick - 6;
    const localTick = pair.a.view().matchTick;
    expect(commonTick).toBeGreaterThanOrEqual(localTick);
    pair.aClock.advance(
      ((commonTick - localTick) * 1_000) / RULES.timing.ticksPerSecond,
    );
    pair.a.pump();
    expect(pair.a.view().matchTick).toBe(commonTick);

    const before = pair.a.view().local!.player;
    pair.bus.releaseHeld(gameplayHold);
    expect(onIncomingAttack).not.toHaveBeenCalled();
    expect(pair.a.view().local?.player.incomingGarbage).toEqual(
      before.incomingGarbage,
    );

    pair.a.setHidden(true);
    expect(pair.b.view()).toMatchObject({
      phase: "network-pause",
      matchTick: commonTick,
    });
    pair.a.setHidden(false);

    expect(pair.a.view()).toMatchObject({ phase: "countdown", matchTick: commonTick });
    expect(pair.b.view()).toMatchObject({ phase: "countdown", matchTick: commonTick });
    expect(onIncomingAttack).not.toHaveBeenCalled();
    expect(pair.a.view().local?.player.incomingGarbage).toEqual(
      before.incomingGarbage,
    );
    expect(pair.a.view().local?.player.forcedQueue).toEqual(before.forcedQueue);
    expect(pair.a.view().local?.player.statuses).toEqual(before.statuses);
  });

  it("accepts a fresh same-tick resume snapshot after local input changed its hash", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000, 100);
    const published = pair.a.view().remote!;

    pair.b.dispatch("move-left");
    const changed = pair.b.view().local!;
    expect(changed.tick).toBe(published.stateTick);
    expect(changed.stateHash).not.toBe(published.stateHash);
    pair.b.setHidden(true);
    pair.b.disconnect();
    pair.b.attachTransport(pair.bus.connect("runtime-b-same-tick-resume"));
    pair.b.setHidden(false);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    expect(pair.a.view().remote).toMatchObject({
      stateTick: changed.tick,
      stateHash: changed.stateHash,
    });
    expect(pair.a.view().remote!.snapshotSeq).toBeGreaterThan(
      published.snapshotSeq,
    );
  });

  it("uses authenticated non-keepalive traffic to progress recovery", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    pair.aClock.advance(RULES.network.missingPeerMs);
    pair.a.pump();

    // The ACK for NETWORK_PAUSE is enough to prove the channel is usable;
    // recovery must not wait indefinitely for a particular keepalive frame.
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("does not resume when a hidden peer attaches a replacement transport", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    pair.b.setHidden(true);
    pair.b.disconnect();
    pair.b.attachTransport(pair.bus.connect("runtime-b-hidden-replacement"));
    advanceBoth(pair, RULES.network.keepaliveMs * 2, 100);

    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");

    pair.b.setHidden(false);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("retries resume clock sync instead of desynchronizing after three seconds", () => {
    const onRecoveryNeeded = vi.fn<() => void>();
    const pair = createPair({ onATransportRecoveryNeeded: onRecoveryNeeded });
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    pair.b.setHidden(true);
    const pongHold = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "CLOCK_PONG";
      },
    );

    pair.b.setHidden(false);
    advanceBoth(pair, RULES.network.missingPeerMs, 100);

    expect(pair.a.view().phase).toBe("network-pause");
    expect(onRecoveryNeeded).toHaveBeenCalled();
    pair.bus.releaseHeld(pongHold);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("retries a lost resume clock commit instead of desynchronizing", () => {
    const onRecoveryNeeded = vi.fn<() => void>();
    const pair = createPair({ onATransportRecoveryNeeded: onRecoveryNeeded });
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    pair.b.setHidden(true);
    const commitHold = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "CLOCK_COMMIT";
      },
    );

    pair.b.setHidden(false);
    advanceBoth(pair, RULES.network.missingPeerMs, 100);

    expect(pair.a.view().phase).toBe("network-pause");
    expect(onRecoveryNeeded).toHaveBeenCalled();
    pair.bus.releaseHeld(commitHold);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("ends a partial-traffic resume incident at its absolute sixty-second deadline", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    pair.b.setHidden(true);
    pair.bus.holdMatching("runtime-b", "runtime-a", (data) => {
      const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
      return decoded.ok && decoded.value.kind === "CLOCK_PONG";
    });

    pair.b.setHidden(false);
    advanceBoth(pair, RULES.network.reconnectGraceMs, 1_000);

    expect(pair.a.view()).toMatchObject({
      phase: "finished",
      connectionStatus: "lost",
      terminal: { outcome: "desync", reason: "connection-lost" },
    });
  });

  it("keeps playing while authenticated opponent traffic arrives between keepalives", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000);

    pair.aClock.advance(RULES.network.missingPeerMs - 1);
    pair.bEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-b",
        sessionId: "session-b",
        kind: "READY",
        matchTick: pair.b.view().matchTick,
        sentAtMonotonicMs: pair.bClock.now(),
        payload: { ready: true, rulesHash: "rules-v1-hash" },
      }),
    );
    pair.a.pump();
    pair.aClock.advance(RULES.network.missingPeerMs - 1);
    pair.a.pump();

    expect(pair.a.view().phase).toBe("playing");
    expect(pair.a.view().peerMissing).toBe(false);
  });

  it("freezes at three seconds and retries channel replacement from five seconds", () => {
    const onRecoveryNeeded = vi.fn<() => void>();
    const pair = createPair({ onATransportRecoveryNeeded: onRecoveryNeeded });
    ready(pair);
    advanceBoth(pair, 3_000);
    pair.b.disconnect();

    advanceBoth(pair, RULES.network.missingPeerMs - 1, 100);
    expect(pair.a.view()).toMatchObject({
      phase: "playing",
      connectionStatus: "connected",
      recoveryRequired: false,
    });

    advanceBoth(pair, 1, 1);
    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      connectionStatus: "unstable",
      recoveryRequired: false,
    });
    expect(onRecoveryNeeded).not.toHaveBeenCalled();

    advanceBoth(
      pair,
      RULES.network.reconnectingMs - RULES.network.missingPeerMs,
      100,
    );
    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      connectionStatus: "reconnecting",
      recoveryRequired: true,
    });
    pair.a.pump();
    expect(onRecoveryNeeded).toHaveBeenCalledTimes(1);

    advanceBoth(pair, RULES.network.reconnectingMs - 1, 100);
    expect(onRecoveryNeeded).toHaveBeenCalledTimes(1);
    advanceBoth(pair, 1, 1);
    expect(onRecoveryNeeded).toHaveBeenCalledTimes(2);
  });

  it("contains failed channel replacement callbacks and keeps retrying", () => {
    const diagnostics = new NetworkDiagnostics({ clock: new ManualClock(1_000) });
    let invocation = 0;
    const onRecoveryNeeded = vi.fn<() => boolean | void>(() => {
      invocation += 1;
      if (invocation === 1) throw new Error("realtime listener already exists");
      return false;
    });
    const pair = createPair({
      aDiagnostics: diagnostics,
      onATransportRecoveryNeeded: onRecoveryNeeded,
    });
    ready(pair);
    advanceBoth(pair, 3_000);
    pair.b.disconnect();

    expect(() => advanceBoth(pair, RULES.network.reconnectingMs)).not.toThrow();
    expect(onRecoveryNeeded).toHaveBeenCalledTimes(1);

    expect(() => advanceBoth(pair, RULES.network.reconnectingMs)).not.toThrow();
    expect(onRecoveryNeeded).toHaveBeenCalledTimes(2);
    expect(
      diagnostics
        .snapshot()
        .incidents[0]?.events.filter(
          (event) => event.kind === "channel-replacement-failed",
        )
        .map((event) => event.attempt),
    ).toEqual([1, 2]);
  });

  it("records a privacy-safe connection recovery timeline", () => {
    const diagnostics = new NetworkDiagnostics({ clock: new ManualClock(1_000) });
    const pair = createPair({ aDiagnostics: diagnostics });
    ready(pair);
    advanceBoth(pair, 3_000);
    pair.b.disconnect();
    advanceBoth(pair, RULES.network.reconnectingMs);

    const replacement = pair.bus.connect("runtime-b-diagnostics");
    pair.b.attachTransport(replacement);
    advanceBoth(pair, 3_000);

    expect(
      diagnostics.snapshot().incidents[0]?.events.map((event) => event.kind),
    ).toEqual([
      "connection-unstable",
      "channel-replacement-requested",
      "peer-traffic-restored",
      "resume-state-sent",
      "resume-countdown",
      "resumed",
    ]);
    expect(diagnostics.copyText()).not.toMatch(/player-a|player-b|payload|input/i);
  });

  it("survives multiple level boundaries, packet chaos, and channel replacement", () => {
    const onDesynchronization = vi.fn<(reason: string) => void>();
    let pair: ReturnType<typeof createPair>;
    let runtimeA = "runtime-a";
    let runtimeB = "runtime-b";
    let aAttached = true;
    let bAttached = true;
    let replacementOrdinal = 0;
    pair = createPair({
      onADesynchronization: onDesynchronization,
      onATransportRecoveryNeeded: () => {
        if (aAttached) return;
        replacementOrdinal += 1;
        runtimeA = `runtime-a-chaos-${replacementOrdinal}`;
        aAttached = true;
        pair.a.attachTransport(pair.bus.connect(runtimeA));
      },
      onBTransportRecoveryNeeded: () => {
        if (bAttached) return;
        replacementOrdinal += 1;
        runtimeB = `runtime-b-chaos-${replacementOrdinal}`;
        bAttached = true;
        pair.b.attachTransport(pair.bus.connect(runtimeB));
      },
    });
    ready(pair);
    advanceBoth(pair, 3_000, 100);

    for (let elapsedMs = 0; elapsedMs < 145_000; elapsedMs += 100) {
      if (elapsedMs === 65_000) {
        pair.a.disconnect();
        pair.b.disconnect();
        aAttached = false;
        bAttached = false;
      }
      if (aAttached && bAttached) {
        if (elapsedMs % 1_900 === 0) {
          pair.bus.dropNext(runtimeA, runtimeB);
        }
        if (elapsedMs % 2_300 === 0) {
          pair.bus.dropNext(runtimeB, runtimeA);
        }
        if (elapsedMs % 3_100 === 0) {
          pair.bus.duplicateNext(runtimeA, runtimeB);
          pair.bus.duplicateNext(runtimeB, runtimeA);
        }
        if (elapsedMs % 3_700 === 0) {
          pair.bus.delayNext(runtimeA, runtimeB);
          pair.bus.delayNext(runtimeB, runtimeA);
        }
      }
      if (elapsedMs % 500 === 0) {
        steerCurrentPiece(pair.a);
        steerCurrentPiece(pair.b);
      }
      advanceBoth(pair, 100, 100);
      pair.bus.releaseDelayed(elapsedMs % 7_400 === 0);
    }
    advanceBoth(pair, 500, 100);

    expect(replacementOrdinal).toBe(2);
    expect(onDesynchronization).not.toHaveBeenCalled();
    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    expect(pair.a.view().matchTick).toBeGreaterThan(
      RULES.timing.levelTicks * 2,
    );
    expect(pair.a.view().matchTick).toBe(pair.b.view().matchTick);
    expect(pair.a.view().local?.level).toBeGreaterThanOrEqual(3);
  });

  it("ends neutrally once after sixty seconds of silence", () => {
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
    pair.aClock.advance(
      RULES.network.reconnectGraceMs - RULES.network.missingPeerMs - 1,
    );
    pair.a.pump();
    expect(onForfeitWin).not.toHaveBeenCalled();
    expect(onAResult).not.toHaveBeenCalled();

    pair.aClock.advance(1);
    pair.a.pump();
    pair.a.pump();
    expect(onForfeitWin).not.toHaveBeenCalled();
    expect(pair.a.view().phase).toBe("finished");
    expect(pair.a.view().connectionStatus).toBe("lost");
    expect(pair.a.view().terminal).toMatchObject({
      outcome: "desync",
      reason: "connection-lost",
    });
    expect(onAResult).toHaveBeenCalledTimes(1);
    expect(onAResult).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "desync",
        reason: "connection-lost",
        completedBy: "player-a",
      }),
    );
  });

  it("records the same neutral loss when either local channel is unavailable", () => {
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
    advanceBoth(
      pair,
      RULES.network.reconnectGraceMs - RULES.network.missingPeerMs,
    );
    pair.b.pump();

    expect(onAResult).toHaveBeenCalledTimes(1);
    expect(onBResult).toHaveBeenCalledTimes(1);
    expect(onBResult).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "desync",
        reason: "connection-lost",
        completedBy: "player-a",
      }),
    );
    expect(pair.a.view().result).toEqual(pair.b.view().result);
  });

  it("retries a dropped explicit forfeit before reporting canonical delivery", () => {
    const onAResult = vi.fn<(result: MatchResultV1) => void>();
    const onBResult = vi.fn<(result: MatchResultV1) => void>();
    const pair = createPair({
      onAResultConfirmed: onAResult,
      onBResultConfirmed: onBResult,
    });
    ready(pair);
    advanceBoth(pair, 3_000);
    pair.bus.dropNext("runtime-b", "runtime-a");

    pair.b.forfeit();

    expect(pair.b.forfeitDeliveryStatus()).toBe("pending");
    expect(onAResult).not.toHaveBeenCalled();
    expect(onBResult).not.toHaveBeenCalled();

    pair.bClock.advance(RULES.network.retryMs - 1);
    pair.b.pump();
    expect(pair.b.forfeitDeliveryStatus()).toBe("pending");
    expect(onAResult).not.toHaveBeenCalled();

    pair.bClock.advance(1);
    pair.b.pump();

    expect(pair.b.forfeitDeliveryStatus()).toBe("acknowledged");
    expect(onAResult).toHaveBeenCalledTimes(1);
    expect(onBResult).not.toHaveBeenCalled();
    expect(pair.a.view().result).toEqual(pair.b.view().result);
    expect(pair.a.view().result).toMatchObject({
      outcome: "seat-a",
      reason: "forfeit",
      completedBy: "player-b",
    });
    expect(pair.b.queueForfeitFallback()).toBe(false);
  });

  it("timestamps an explicit forfeit at its canonical simulation snapshot", () => {
    const onAResult = vi.fn<(result: MatchResultV1) => void>();
    const pair = createPair({ onAResultConfirmed: onAResult });
    ready(pair);
    advanceBoth(pair, 3_000);
    pair.bClock.advance(100);

    pair.b.forfeit();

    expect(pair.b.forfeitDeliveryStatus()).toBe("acknowledged");
    expect(onAResult).toHaveBeenCalledTimes(1);
    expect(onAResult).toHaveBeenCalledWith(pair.b.view().result);
  });

  it("queues one canonical self-loss fallback when explicit forfeit cannot be acknowledged", () => {
    const onAResult = vi.fn<(result: MatchResultV1) => void>();
    const onBResult = vi.fn<(result: MatchResultV1) => void>();
    const pair = createPair({
      onAResultConfirmed: onAResult,
      onBResultConfirmed: onBResult,
    });
    ready(pair);
    advanceBoth(pair, 3_000);
    pair.a.disconnect();

    pair.b.forfeit();

    expect(pair.b.forfeitDeliveryStatus()).toBe("pending");
    expect(pair.b.queueForfeitFallback()).toBe(true);
    expect(pair.b.queueForfeitFallback()).toBe(false);
    expect(pair.b.forfeitDeliveryStatus()).toBe("fallback-queued");
    expect(onAResult).not.toHaveBeenCalled();
    expect(onBResult).toHaveBeenCalledTimes(1);
    expect(onBResult).toHaveBeenCalledWith(pair.b.view().result);
    expect(pair.b.view().result).toMatchObject({
      outcome: "seat-a",
      reason: "forfeit",
      completedBy: "player-b",
    });
  });
});
