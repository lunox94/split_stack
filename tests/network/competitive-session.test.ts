import { describe, expect, it, vi } from "vitest";
import { RULES } from "../../src/config/rules";
import { clearLines, findCompleteLines, mergePiece } from "../../src/domain/board";
import { collides } from "../../src/domain/collision";
import { getGhostY } from "../../src/domain/movement";
import type { MatchResult } from "../../src/domain/types";
import type { ActivePiece, Grid, Rotation } from "../../src/domain/types";
import type { SimulationEffect } from "../../src/domain/simulation";
import {
  CLOCK_SYNC_PROBE_SPACING_MS,
  CLOCK_SYNC_RETRY_BASE_MS,
  CLOCK_SYNC_RETRY_MAX_MS,
  CLOCK_SYNC_RESUME_SAMPLE_TARGET,
  CLOCK_SYNC_SAMPLE_TARGET,
} from "../../src/network/clock";
import { decodeEnvelope, encodeEnvelope } from "../../src/network/codec";
import { NetworkDiagnostics } from "../../src/network/diagnostics";
import { InMemoryRealtimeBus, ManualClock } from "../../src/network/in-memory";
import type { RealtimeEnvelope } from "../../src/network/messages";
import { CRITICAL_INITIAL_RETRANSMIT_MS } from "../../src/network/reliability";
import {
  CompetitiveSession,
  type CompetitiveIncomingAttackKind,
  type CompetitiveRealtimeTransport,
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
  onAResultConfirmed?: (result: MatchResult) => void;
  onBResultConfirmed?: (result: MatchResult) => void;
  onAStartCommitted?: () => void;
  onBStartCommitted?: () => void;
  onADesynchronization?: (reason: string) => void;
  onATransportRecoveryNeeded?: () => boolean | void;
  onBTransportRecoveryNeeded?: () => boolean | void;
  aDiagnostics?: NetworkDiagnostics;
  snapshotIntervalTicks?: number | null;
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
    ...(overrides.onAStartCommitted === undefined
      ? {}
      : { onStartCommitted: overrides.onAStartCommitted }),
    ...(overrides.onADesynchronization === undefined
      ? {}
      : { onDesynchronization: overrides.onADesynchronization }),
    ...(overrides.onATransportRecoveryNeeded === undefined
      ? {}
      : { onTransportRecoveryNeeded: overrides.onATransportRecoveryNeeded }),
    ...(overrides.aDiagnostics === undefined
      ? {}
      : { diagnostics: overrides.aDiagnostics }),
    ...(overrides.snapshotIntervalTicks === undefined
      ? {}
      : { snapshotIntervalTicks: overrides.snapshotIntervalTicks }),
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
    ...(overrides.onBStartCommitted === undefined
      ? {}
      : { onStartCommitted: overrides.onBStartCommitted }),
    ...(overrides.onBTransportRecoveryNeeded === undefined
      ? {}
      : { onTransportRecoveryNeeded: overrides.onBTransportRecoveryNeeded }),
    ...(overrides.snapshotIntervalTicks === undefined
      ? {}
      : { snapshotIntervalTicks: overrides.snapshotIntervalTicks }),
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
  advanceBoth(
    pair,
    CLOCK_SYNC_PROBE_SPACING_MS * (CLOCK_SYNC_SAMPLE_TARGET - 1),
    CLOCK_SYNC_PROBE_SPACING_MS,
  );
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

function stabilizeRecovery(pair: ReturnType<typeof createPair>): void {
  const deadlineMs = 2_000;
  let elapsedMs = 0;
  while (
    elapsedMs < deadlineMs &&
    pair.a.view().phase === "network-pause" &&
    pair.b.view().phase === "network-pause"
  ) {
    advanceBoth(pair, 50, 50);
    elapsedMs += 50;
  }
}

function holdOneResumeCapableFrame(
  pair: ReturnType<typeof createPair>,
  kind: "HELLO" | "KEEPALIVE",
): number {
  let held = false;
  return pair.bus.holdMatching("runtime-b", "runtime-a", (data) => {
    const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
    if (
      held ||
      !decoded.ok ||
      decoded.value.kind !== kind ||
      !decoded.value.payload.resumeAvailable
    ) {
      return false;
    }
    held = true;
    return true;
  });
}

function throwNextKind(
  transport: CompetitiveRealtimeTransport,
  kind: RealtimeEnvelope["kind"],
): CompetitiveRealtimeTransport {
  let armed = true;
  return {
    setListener: (listener) => transport.setListener(listener),
    send: (data) => {
      const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
      if (armed && decoded.ok && decoded.value.kind === kind) {
        armed = false;
        throw new Error(`injected ${kind} send failure`);
      }
      transport.send(data);
    },
    leave: () => transport.leave(),
  };
}

function retainOneProbeEchoCallback(
  transport: CompetitiveRealtimeTransport,
): {
  transport: CompetitiveRealtimeTransport;
  arm(): void;
  hasRetainedFrame(): boolean;
  retainedFrame(): Uint8Array;
  invokeDepartedListener(): void;
} {
  let listener: ((data: Uint8Array) => void) | null = null;
  let retainedFrame: Uint8Array | null = null;
  let armed = false;
  return {
    transport: {
      setListener: (nextListener) => {
        listener = nextListener;
        transport.setListener((data) => {
          const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
          if (
            armed &&
            decoded.ok &&
            decoded.value.kind === "KEEPALIVE" &&
            decoded.value.payload.echoProbeSeq !== undefined
          ) {
            retainedFrame = data.slice();
            armed = false;
            return;
          }
          nextListener(data);
        });
      },
      send: (data) => transport.send(data),
      leave: () => transport.leave(),
    },
    arm: () => {
      armed = true;
    },
    hasRetainedFrame: () => retainedFrame !== null,
    retainedFrame: () => {
      if (retainedFrame === null) {
        throw new Error("No probe echo frame was retained");
      }
      return retainedFrame.slice();
    },
    invokeDepartedListener: () => {
      if (listener === null || retainedFrame === null) {
        throw new Error("No departed transport callback was retained");
      }
      listener(retainedFrame);
    },
  };
}

function retainOneCriticalAck(
  transport: CompetitiveRealtimeTransport,
): {
  transport: CompetitiveRealtimeTransport;
  arm(): void;
  hasRetainedFrame(): boolean;
  retainedFrame(): Uint8Array;
} {
  let retainedFrame: Uint8Array | null = null;
  let armed = false;
  return {
    transport: {
      setListener: (listener) => {
        transport.setListener((data) => {
          const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
          if (armed && decoded.ok && decoded.value.kind === "KEEPALIVE") {
            // Applying a critical frame can emit a cursor-bearing keepalive before
            // its explicit ACK. Suppress it so the retained ACK is the only proof.
            return;
          }
          if (
            armed &&
            decoded.ok &&
            decoded.value.kind === "ACK" &&
            decoded.value.payload.seqs.length > 0
          ) {
            retainedFrame = data.slice();
            armed = false;
            return;
          }
          listener(data);
        });
      },
      send: (data) => transport.send(data),
      leave: () => transport.leave(),
    },
    arm: () => {
      armed = true;
    },
    hasRetainedFrame: () => retainedFrame !== null,
    retainedFrame: () => {
      if (retainedFrame === null) {
        throw new Error("No critical acknowledgement was retained");
      }
      return retainedFrame.slice();
    },
  };
}

function emulateLegacyStartCommitPeer(
  transport: CompetitiveRealtimeTransport,
): CompetitiveRealtimeTransport {
  return {
    setListener: (listener) => transport.setListener(listener),
    send: (data) => {
      const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
      if (decoded.ok && decoded.value.kind === "READY") {
        const envelope: RealtimeEnvelope<"READY"> = {
          ...decoded.value,
          payload: {
            ready: decoded.value.payload.ready,
            rulesHash: decoded.value.payload.rulesHash,
          },
        };
        transport.send(encodeEnvelope(envelope));
        return;
      }
      if (decoded.ok && decoded.value.kind === "ACK") {
        const envelope: RealtimeEnvelope<"ACK"> = {
          ...decoded.value,
          payload: {
            stream: decoded.value.payload.stream,
            seqs: decoded.value.payload.seqs,
          },
        };
        transport.send(encodeEnvelope(envelope));
        return;
      }
      transport.send(data);
    },
    leave: () => transport.leave(),
  };
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
    const heldPresence = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok &&
          (decoded.value.kind === "HELLO" || decoded.value.kind === "READY");
      },
    );
    ready(pair);
    expect(pair.a.view().phase).toBe("lobby");

    pair.bus.discardHeld(heldPresence);
    advanceBoth(pair, RULES.network.keepaliveMs);
    advanceBoth(
      pair,
      CLOCK_SYNC_PROBE_SPACING_MS * (CLOCK_SYNC_SAMPLE_TARGET - 1),
      CLOCK_SYNC_PROBE_SPACING_MS,
    );

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("announces the initial synchronized start commit exactly once per player", () => {
    const onAStartCommitted = vi.fn();
    const onBStartCommitted = vi.fn();
    const pair = createPair({ onAStartCommitted, onBStartCommitted });

    ready(pair);
    pair.a.pump();
    pair.b.pump();

    expect(onAStartCommitted).toHaveBeenCalledTimes(1);
    expect(onBStartCommitted).toHaveBeenCalledTimes(1);
  });

  it("keeps start negotiation compatible with a peer that predates semantic receipts", () => {
    const pair = createPair();
    pair.b.disconnect("replacement");
    pair.b.attachTransport(
      emulateLegacyStartCommitPeer(pair.bus.connect("runtime-b-legacy")),
    );

    ready(pair);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    expect(pair.a.view().countdownTicks).toBe(pair.b.view().countdownTicks);
  });

  it("keeps both players stopped until an expired start commit is delivered again with a fresh lead", () => {
    const pair = createPair();
    const heldCommits = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "START_COMMIT";
      },
    );

    ready(pair);
    const beyondDeadlineMs =
      (RULES.network.initialStartCountdownTicks * 1_000) /
        RULES.timing.ticksPerSecond +
      500;
    pair.aClock.advance(beyondDeadlineMs);
    pair.bClock.advance(beyondDeadlineMs);
    pair.b.pump();

    expect(pair.a.view().phase).not.toBe("playing");
    expect(pair.b.view().phase).not.toBe("playing");

    pair.bus.releaseHeld(heldCommits);
    advanceBoth(pair, 50, 50);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    expect(pair.a.view().countdownTicks).toBeGreaterThan(120);
    expect(pair.a.view().countdownTicks).toBe(pair.b.view().countdownTicks);

    advanceBoth(
      pair,
      (RULES.network.initialStartCountdownTicks * 1_000) /
        RULES.timing.ticksPerSecond,
      50,
    );
    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
  });

  it("keeps an accepted start when its direct acknowledgement is lost and a cursor arrives late", () => {
    const pair = createPair();
    let commitSequence: number | null = null;
    const startEventIds: string[] = [];
    const observeStarts = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (!decoded.ok) return false;
        if (decoded.value.kind === "START") {
          startEventIds.push(decoded.value.payload.eventId);
        } else if (decoded.value.kind === "START_COMMIT") {
          commitSequence ??= decoded.value.seq ?? null;
        }
        return false;
      },
    );
    const droppedDirectCommitAck = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        const sequence = commitSequence;
        if (!decoded.ok || sequence === null) return false;
        return decoded.value.kind === "ACK" &&
          decoded.value.payload.seqs.includes(sequence);
      },
    );
    const heldEarlyCommitCursors = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        const sequence = commitSequence;
        if (!decoded.ok || sequence === null) return false;
        return decoded.value.kind === "KEEPALIVE" &&
          decoded.value.payload.inboundCritical.some(
            (cursor) => cursor.contiguousThrough >= sequence,
          );
      },
    );

    ready(pair);
    expect(pair.a.view().phase).toBe("synchronizing");
    expect(pair.b.view().phase).toBe("countdown");
    advanceBoth(
      pair,
      (RULES.network.initialStartCountdownTicks * 1_000) /
        RULES.timing.ticksPerSecond +
        500,
      50,
    );
    expect(pair.b.view().phase).toBe("playing");

    // Throw away every cursor created while the commit was still timely, then
    // allow only a newly generated post-deadline cursor to reach A.
    pair.bus.discardHeld(heldEarlyCommitCursors);
    const heldLateCommitCursor = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        const sequence = commitSequence;
        if (!decoded.ok || sequence === null) return false;
        return decoded.value.kind === "KEEPALIVE" &&
          decoded.value.payload.inboundCritical.some(
            (cursor) => cursor.contiguousThrough >= sequence,
          );
      },
    );
    pair.aClock.advance(RULES.network.keepaliveMs);
    pair.bClock.advance(RULES.network.keepaliveMs);
    pair.b.pump();
    expect(pair.a.view().phase).toBe("synchronizing");

    pair.bus.discardHeld(droppedDirectCommitAck);
    pair.bus.releaseHeld(heldLateCommitCursor);
    pair.a.pump();
    pair.bus.discardHeld(observeStarts);

    expect(pair.a.view().phase).toBe("playing");
    expect(new Set(startEventIds).size).toBe(1);
    expect(pair.a.view().matchTick).toBe(pair.b.view().matchTick);
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
    advanceBoth(
      pair,
      CLOCK_SYNC_PROBE_SPACING_MS * (CLOCK_SYNC_SAMPLE_TARGET - 1),
      CLOCK_SYNC_PROBE_SPACING_MS,
    );

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("cancels an in-flight initial clock sync when the coordinator is hidden", () => {
    const onDesynchronization = vi.fn<(reason: string) => void>();
    const pair = createPair({ onADesynchronization: onDesynchronization });
    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    const heldPongs = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "CLOCK_PONG";
      },
    );
    pair.b.setReady(true);
    expect(pair.a.view().phase).toBe("synchronizing");

    pair.a.setHidden(true);
    advanceBoth(pair, RULES.network.missingPeerMs, 50);
    pair.bus.discardHeld(heldPongs);

    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      localReady: false,
    });
    expect(pair.b.view()).toMatchObject({
      phase: "lobby",
      peerReady: false,
    });
    expect(onDesynchronization).not.toHaveBeenCalled();

    pair.a.setHidden(false);
    expect(pair.a.view()).toMatchObject({ phase: "lobby", localReady: false });
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
    expect(aCountdown.countdownTicks).toBe(
      RULES.network.initialStartCountdownTicks,
    );

    advanceBoth(
      pair,
      (RULES.network.initialStartCountdownTicks * 1_000) /
        RULES.timing.ticksPerSecond,
    );
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

  it.each([
    { intervalTicks: 12, expectedSequence: 4, expectedTick: 36 },
    { intervalTicks: 30, expectedSequence: 2, expectedTick: 30 },
    { intervalTicks: null, expectedSequence: 1, expectedTick: 0 },
  ])(
    "publishes regular snapshots using the $intervalTicks-tick transport profile",
    ({ intervalTicks, expectedSequence, expectedTick }) => {
      const pair = createPair({ snapshotIntervalTicks: intervalTicks });
      ready(pair);
      advanceBoth(pair, 3_000);

      // Starting state is authoritative even when periodic snapshots are disabled.
      expect(pair.a.view().remote).toMatchObject({
        snapshotSeq: 1,
        stateTick: 0,
      });

      advanceBoth(pair, 600, 100);

      expect(pair.a.view().remote).toMatchObject({
        snapshotSeq: expectedSequence,
        stateTick: expectedTick,
      });
    },
  );

  it("answers a targeted state request with one forced snapshot when periodic snapshots are disabled", () => {
    const pair = createPair({ snapshotIntervalTicks: null });
    ready(pair);
    advanceBoth(pair, 3_000, 50);
    const snapshots: RealtimeEnvelope<"SNAPSHOT">[] = [];
    const observer = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "SNAPSHOT") {
          snapshots.push(decoded.value);
        }
        return false;
      },
    );

    pair.bEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-b",
        sessionId: "session-b",
        kind: "STATE_REQUEST",
        matchTick: pair.b.view().matchTick,
        sentAtMonotonicMs: pair.bClock.now(),
        payload: { targetPlayerIds: ["player-a"] },
      }),
    );
    pair.bus.discardHeld(observer);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.payload.stateTick).toBe(pair.a.view().matchTick);
  });

  it("downshifts periodic snapshots when the peer's accepted cursor remains behind", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000, 50);
    const blockedSnapshots = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "SNAPSHOT";
      },
    );

    advanceBoth(pair, 4_000, 50);

    expect(pair.a.view()).toMatchObject({ snapshotIntervalTicks: 12 });
    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    pair.bus.discardHeld(blockedSnapshots);
  });

  it("restores the normal snapshot cadence after sustained delivery recovery", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000, 50);
    const blockedSnapshots = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "SNAPSHOT";
      },
    );
    advanceBoth(pair, 4_000, 50);
    expect(pair.a.view().snapshotIntervalTicks).toBe(12);

    pair.bus.discardHeld(blockedSnapshots);
    advanceBoth(pair, 31_000, 50);

    expect(pair.a.view().phase).toBe("playing");
    expect(pair.a.view().snapshotIntervalTicks).toBe(
      RULES.network.snapshotTicks,
    );
  });

  it("still publishes a forced resume snapshot with periodic snapshots disabled", () => {
    const pair = createPair({ snapshotIntervalTicks: null });
    ready(pair);
    advanceBoth(
      pair,
      (RULES.network.initialStartCountdownTicks * 1_000) /
        RULES.timing.ticksPerSecond,
    );
    const initial = pair.a.view().remote!;
    pair.b.dispatch("move-left");

    const resumeEndpointId = "runtime-b-no-periodic-snapshots-resume";
    const resumeSnapshots: RealtimeEnvelope<"SNAPSHOT">[] = [];
    const observerId = pair.bus.holdMatching(
      resumeEndpointId,
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "SNAPSHOT") {
          resumeSnapshots.push(decoded.value);
        }
        return false;
      },
    );

    pair.b.setHidden(true);
    pair.b.disconnect();
    pair.b.attachTransport(pair.bus.connect(resumeEndpointId));
    pair.b.setHidden(false);
    stabilizeRecovery(pair);
    pair.bus.discardHeld(observerId);

    expect({
      aPhase: pair.a.view().phase,
      bPhase: pair.b.view().phase,
      snapshots: resumeSnapshots.length,
    }).toEqual({ aPhase: "countdown", bPhase: "countdown", snapshots: 1 });
    expect(resumeSnapshots[0]?.payload.snapshotSeq).toBeGreaterThan(
      initial.snapshotSeq,
    );
  });

  it("still sends the terminal snapshot immediately before top-out with periodic snapshots disabled", () => {
    const pair = createPair({ snapshotIntervalTicks: null });
    ready(pair);
    advanceBoth(pair, 3_000);

    const sentKinds: string[] = [];
    const observerId = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok) sentKinds.push(decoded.value.kind);
        return false;
      },
    );

    for (let piece = 0; piece < 200 && pair.a.view().phase === "playing"; piece += 1) {
      pair.a.dispatch("hard-drop");
    }
    pair.bus.discardHeld(observerId);

    const topOutIndex = sentKinds.indexOf("TOP_OUT");
    expect(sentKinds.slice(topOutIndex - 1, topOutIndex + 1)).toEqual([
      "SNAPSHOT",
      "TOP_OUT",
    ]);
  });

  it("omits an unchanged remote snapshot when the renderer supplies its sequence", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000);
    const current = pair.a.view().remote!;

    expect(
      pair.a.view({ afterRemoteSnapshotSeq: current.snapshotSeq }).remote,
    ).toBeUndefined();

    advanceBoth(pair, 100, 100);
    expect(
      pair.a.view({ afterRemoteSnapshotSeq: current.snapshotSeq }).remote?.snapshotSeq,
    ).toBeGreaterThan(current.snapshotSeq);
  });

  it("coalesces regular snapshots after a one-second pump stall", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000);

    const sent: RealtimeEnvelope<"SNAPSHOT">[] = [];
    const holdId = pair.bus.holdMatching("runtime-a", "runtime-b", (data) => {
      const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
      if (!decoded.ok || decoded.value.kind !== "SNAPSHOT") return false;
      sent.push(decoded.value);
      return true;
    });

    pair.aClock.advance(1_000);
    pair.a.pump();
    pair.bus.discardHeld(holdId);

    expect(pair.a.view().matchTick).toBe(60);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      matchTick: 60,
      payload: { stateTick: 60 },
    });
  });

  it("does not send realtime frames for a burst of local movement inputs", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000);
    const sentKinds: string[] = [];
    const observer = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok) sentKinds.push(decoded.value.kind);
        return false;
      },
    );

    for (let index = 0; index < 40; index += 1) {
      pair.a.dispatch(index % 2 === 0 ? "move-left" : "move-right");
      pair.a.dispatch("rotate-cw");
    }

    expect(sentKinds).toEqual([]);
    pair.aClock.advance(100);
    expect(sentKinds).toEqual([]);

    pair.a.pump();
    pair.bus.discardHeld(observer);
    expect(sentKinds).toEqual(["SNAPSHOT"]);
  });

  it("retries a missing clock sample during the initial handshake", () => {
    const pair = createPair();
    let heldOnePong = false;
    const missingPong = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (
          heldOnePong ||
          !decoded.ok ||
          decoded.value.kind !== "CLOCK_PONG"
        ) return false;
        heldOnePong = true;
        return true;
      },
    );
    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    pair.b.setReady(true);
    advanceBoth(
      pair,
      CLOCK_SYNC_PROBE_SPACING_MS * (CLOCK_SYNC_SAMPLE_TARGET - 1),
      CLOCK_SYNC_PROBE_SPACING_MS,
    );
    pair.bus.discardHeld(missingPong);

    expect(pair.a.view().phase).toBe("synchronizing");
    expect(pair.a.view().clockSampleIds).toHaveLength(0);

    advanceBoth(pair, CLOCK_SYNC_RETRY_BASE_MS);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    expect(pair.a.view().clockSampleIds).toHaveLength(3);
  });

  it("paces clock probes across the initial synchronization window", () => {
    const pair = createPair();
    let pingsSent = 0;
    const observer = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "CLOCK_PING") pingsSent += 1;
        return false;
      },
    );
    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    pair.b.setReady(true);

    expect(pingsSent).toBe(1);
    advanceBoth(pair, CLOCK_SYNC_PROBE_SPACING_MS - 1, 1);
    expect(pingsSent).toBe(1);
    advanceBoth(pair, 1, 1);
    expect(pingsSent).toBe(2);
    advanceBoth(
      pair,
      CLOCK_SYNC_PROBE_SPACING_MS * (CLOCK_SYNC_SAMPLE_TARGET - 2),
      CLOCK_SYNC_PROBE_SPACING_MS,
    );
    pair.bus.discardHeld(observer);

    expect(pingsSent).toBe(CLOCK_SYNC_SAMPLE_TARGET);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("carries a resume clock probe through the stability boundary", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000, 50);
    pair.b.setHidden(true);
    const probeTimes: number[] = [];
    const observer = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "CLOCK_PING") {
          probeTimes.push(decoded.value.payload.coordinatorSentMs);
        }
        return false;
      },
    );

    pair.b.setHidden(false);
    advanceBoth(pair, RULES.network.recoveryStabilityMs, 50);
    pair.bus.discardHeld(observer);

    expect(probeTimes).toHaveLength(CLOCK_SYNC_RESUME_SAMPLE_TARGET);
    expect(
      probeTimes[probeTimes.length - 1]! - probeTimes[0]!,
    ).toBeGreaterThanOrEqual(
      RULES.network.recoveryStabilityMs,
    );
    stabilizeRecovery(pair);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("falls back to five new clock samples when trusted resume samples disagree", () => {
    const pair = createPair();
    pair.b.disconnect();
    const endpointId = "runtime-b-clock-drift";
    const base = pair.bus.connect(endpointId);
    let corruptResumePongs = false;
    let corrupted = 0;
    const resumeDriftMs = [-100, 0, 100] as const;
    const transport: CompetitiveRealtimeTransport = {
      setListener: (listener) => base.setListener(listener),
      send: (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (
          corruptResumePongs &&
          corrupted < CLOCK_SYNC_RESUME_SAMPLE_TARGET &&
          decoded.ok &&
          decoded.value.kind === "CLOCK_PONG"
        ) {
          const driftMs = resumeDriftMs[corrupted]!;
          corrupted += 1;
          base.send(encodeEnvelope({
            ...decoded.value,
            payload: {
              ...decoded.value.payload,
              peerReceivedMs: decoded.value.payload.peerReceivedMs + driftMs,
              peerSentMs: decoded.value.payload.peerSentMs + driftMs,
            },
          }));
          return;
        }
        base.send(data);
      },
      leave: () => base.leave(),
    };
    pair.b.attachTransport(transport);
    ready(pair);
    advanceBoth(pair, 3_000, 50);

    let resumePings = 0;
    const observePings = pair.bus.holdMatching(
      "runtime-a",
      endpointId,
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "CLOCK_PING") resumePings += 1;
        return false;
      },
    );
    pair.b.setHidden(true);
    corruptResumePongs = true;
    pair.b.setHidden(false);
    advanceBoth(pair, RULES.network.recoveryStabilityMs + 500, 50);
    pair.bus.discardHeld(observePings);

    expect(resumePings).toBe(
      CLOCK_SYNC_RESUME_SAMPLE_TARGET + CLOCK_SYNC_SAMPLE_TARGET,
    );
    stabilizeRecovery(pair);
    expect(pair.b.view()).toMatchObject({
      phase: "countdown",
      clockOffsetMs: 25,
    });
  });

  it("records a valid timeout after a partial full-sync fallback", () => {
    const diagnostics = new NetworkDiagnostics();
    const pair = createPair({ aDiagnostics: diagnostics });
    pair.b.disconnect();
    const endpointId = "runtime-b-partial-clock-fallback";
    const base = pair.bus.connect(endpointId);
    let resumePongs = 0;
    let resumeMode = false;
    pair.b.attachTransport({
      setListener: (listener) => base.setListener(listener),
      send: (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (resumeMode && decoded.ok && decoded.value.kind === "CLOCK_PONG") {
          resumePongs += 1;
          if (resumePongs <= CLOCK_SYNC_RESUME_SAMPLE_TARGET) {
            base.send(encodeEnvelope({
              ...decoded.value,
              payload: {
                ...decoded.value.payload,
                peerReceivedMs: decoded.value.payload.peerReceivedMs + 1_000,
                peerSentMs: decoded.value.payload.peerSentMs + 1_000,
              },
            }));
          } else if (
            resumePongs <=
            CLOCK_SYNC_RESUME_SAMPLE_TARGET + 3
          ) {
            base.send(data);
          }
          return;
        }
        base.send(data);
      },
      leave: () => base.leave(),
    });
    ready(pair);
    advanceBoth(pair, 3_000, 50);

    pair.b.setHidden(true);
    resumeMode = true;
    pair.b.setHidden(false);
    expect(() =>
      advanceBoth(pair, RULES.network.missingPeerMs, 50)
    ).not.toThrow();

    const timeout = diagnostics.snapshot().incidents
      .flatMap((incident) => incident.events)
      .find((event) => event.kind === "clock-sync-timeout");
    expect(timeout?.clockSync).toMatchObject({
      purpose: "resume",
      targetSamples: CLOCK_SYNC_SAMPLE_TARGET,
      acceptedSamples: 3,
      pongsReceived: 3,
    });
  });

  it("accepts delayed clock replies after sending a retry", () => {
    const pair = createPair();
    let pongsHeld = 0;
    const delayedPongs = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (
          pongsHeld >= 2 ||
          !decoded.ok ||
          decoded.value.kind !== "CLOCK_PONG"
        ) return false;
        pongsHeld += 1;
        return true;
      },
    );
    let retryPingsSent = 0;
    let initialProbeWindowComplete = false;
    const observeRetryPings = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (
          initialProbeWindowComplete &&
          decoded.ok &&
          decoded.value.kind === "CLOCK_PING"
        ) {
          retryPingsSent += 1;
        }
        return false;
      },
    );
    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    pair.b.setReady(true);
    advanceBoth(
      pair,
      CLOCK_SYNC_PROBE_SPACING_MS * (CLOCK_SYNC_SAMPLE_TARGET - 1),
      CLOCK_SYNC_PROBE_SPACING_MS,
    );
    initialProbeWindowComplete = true;
    advanceBoth(pair, CLOCK_SYNC_RETRY_BASE_MS, 50);
    pair.bus.releaseHeld(delayedPongs);
    pair.bus.discardHeld(observeRetryPings);

    expect(retryPingsSent).toBeGreaterThan(0);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    expect(pair.b.view().clockOffsetMs).toBe(25);
  });

  it("bounds clock probe traffic during a response outage", () => {
    const pair = createPair();
    let clockPingsSent = 0;
    const observePings = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "CLOCK_PING") {
          clockPingsSent += 1;
        }
        return false;
      },
    );
    const heldPongs = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "CLOCK_PONG";
      },
    );
    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    pair.b.setReady(true);

    advanceBoth(pair, RULES.network.missingPeerMs, 50);
    pair.bus.discardHeld(observePings);
    pair.bus.discardHeld(heldPongs);

    expect(clockPingsSent).toBeLessThanOrEqual(20);
  });

  it("returns the coordinator to readiness when initial clock sync loses the peer", () => {
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

    expect(pair.a.view()).toMatchObject({
      phase: "lobby",
      localReady: false,
    });
    expect(onDesynchronization).not.toHaveBeenCalled();
  });

  it("returns both players to readiness when initial clock sync expires", () => {
    const onDesynchronization = vi.fn<(reason: string) => void>();
    const diagnostics = new NetworkDiagnostics({ clock: new ManualClock(10_000) });
    const pair = createPair({
      aDiagnostics: diagnostics,
      onADesynchronization: onDesynchronization,
    });
    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    const heldPongs = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "CLOCK_PONG";
      },
    );
    pair.b.setReady(true);

    advanceBoth(pair, RULES.network.missingPeerMs, 50);
    pair.bus.discardHeld(heldPongs);

    expect(pair.a.view()).toMatchObject({
      phase: "lobby",
      localReady: false,
      peerReady: true,
    });
    expect(pair.b.view()).toMatchObject({
      phase: "lobby",
      localReady: true,
      peerReady: false,
    });
    expect(onDesynchronization).not.toHaveBeenCalled();
    const incident = diagnostics.snapshot().incidents[0];
    expect(incident).toMatchObject({
      context: { matchId: "match-1", localSeat: "a" },
      events: [{
        kind: "clock-sync-timeout",
        clockSync: {
          purpose: "initial",
          targetSamples: 5,
          acceptedSamples: 0,
          retryRounds: 3,
          pingsSent: expect.any(Number),
          pongsReceived: 0,
          pongOutcomes: {
            accepted: 0,
            unknownSample: 0,
            staleEcho: 0,
            duplicate: 0,
            invalidTiming: 0,
          },
          elapsedMs: RULES.network.missingPeerMs,
          deadlineMs: RULES.network.missingPeerMs,
        },
        telemetry: expect.any(Object),
      }],
    });
    const pingsSent = incident?.events[0]?.clockSync?.pingsSent ?? 0;
    expect(pingsSent).toBeGreaterThanOrEqual(CLOCK_SYNC_SAMPLE_TARGET);
    expect(pingsSent).toBeLessThanOrEqual(CLOCK_SYNC_SAMPLE_TARGET * 4);
  });

  it("classifies rejected clock replies in the timeout diagnostic", () => {
    const diagnostics = new NetworkDiagnostics({ clock: new ManualClock(11_000) });
    const pair = createPair({ aDiagnostics: diagnostics });
    const sentPings: Array<{ sampleId: number; coordinatorSentMs: number }> = [];
    const observePings = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "CLOCK_PING") {
          sentPings.push({ ...decoded.value.payload });
        }
        return false;
      },
    );
    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    const initialPongs = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "CLOCK_PONG";
      },
    );
    pair.b.setReady(true);
    advanceBoth(
      pair,
      CLOCK_SYNC_PROBE_SPACING_MS * (CLOCK_SYNC_SAMPLE_TARGET - 1),
      CLOCK_SYNC_PROBE_SPACING_MS,
    );
    pair.bus.discardHeld(initialPongs);
    pair.bus.discardHeld(observePings);
    expect(sentPings).toHaveLength(CLOCK_SYNC_SAMPLE_TARGET);

    const sendPong = (
      sampleId: number,
      coordinatorSentMs: number,
      peerReceivedMs = pair.bClock.now(),
      peerSentMs = peerReceivedMs,
    ): void => {
      pair.bEndpoint.send(encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-b",
        sessionId: "session-b",
        kind: "CLOCK_PONG",
        matchTick: 0,
        sentAtMonotonicMs: pair.bClock.now(),
        payload: {
          sampleId,
          coordinatorSentMs,
          peerReceivedMs,
          peerSentMs,
        },
      }));
    };
    const stale = sentPings[0]!;
    const invalid = sentPings[1]!;
    const accepted = sentPings[2]!;
    sendPong(999, pair.aClock.now());
    sendPong(stale.sampleId, stale.coordinatorSentMs + 1);
    sendPong(
      invalid.sampleId,
      invalid.coordinatorSentMs,
      pair.bClock.now() + 1,
      pair.bClock.now(),
    );
    sendPong(accepted.sampleId, accepted.coordinatorSentMs);
    sendPong(accepted.sampleId, accepted.coordinatorSentMs);

    const retryPongs = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "CLOCK_PONG";
      },
    );
    advanceBoth(
      pair,
      RULES.network.missingPeerMs -
        CLOCK_SYNC_PROBE_SPACING_MS * (CLOCK_SYNC_SAMPLE_TARGET - 1),
      50,
    );
    pair.bus.discardHeld(retryPongs);

    expect(diagnostics.snapshot().incidents[0]?.events[0]?.clockSync)
      .toMatchObject({
        acceptedSamples: 1,
        retryRounds: 3,
        pingsSent: expect.any(Number),
        pongsReceived: 5,
        pongOutcomes: {
          accepted: 1,
          unknownSample: 1,
          staleEcho: 1,
          duplicate: 1,
          invalidTiming: 1,
        },
        lastPongAgeMs:
          RULES.network.missingPeerMs -
          CLOCK_SYNC_PROBE_SPACING_MS * (CLOCK_SYNC_SAMPLE_TARGET - 1),
      });
  });

  it("retries a missing clock commit before accepting the match config", () => {
    const pair = createPair();
    let heldFirstCommit = false;
    const observedCommitOffsets: number[] = [];
    const missingCommit = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "CLOCK_COMMIT") {
          observedCommitOffsets.push(
            decoded.value.payload.offsetPeerMinusCoordinatorMs,
          );
        }
        if (
          heldFirstCommit ||
          !decoded.ok ||
          decoded.value.kind !== "CLOCK_COMMIT"
        ) return false;
        heldFirstCommit = true;
        return true;
      },
    );
    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    pair.b.setReady(true);
    advanceBoth(
      pair,
      CLOCK_SYNC_PROBE_SPACING_MS * (CLOCK_SYNC_SAMPLE_TARGET - 1),
      CLOCK_SYNC_PROBE_SPACING_MS,
    );

    advanceBoth(pair, RULES.network.retryMs);
    pair.bus.discardHeld(missingCommit);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    expect(observedCommitOffsets).toEqual([25, 25]);
    expect(pair.b.view().clockOffsetMs).toBe(25);
  });

  it("retries a missing config acknowledgement during the initial handshake", () => {
    const pair = createPair();
    let heldFirstAck = false;
    const missingAck = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (
          heldFirstAck ||
          !decoded.ok ||
          decoded.value.kind !== "CONFIG_ACK"
        ) return false;
        heldFirstAck = true;
        return true;
      },
    );
    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    pair.b.setReady(true);
    advanceBoth(
      pair,
      CLOCK_SYNC_PROBE_SPACING_MS * (CLOCK_SYNC_SAMPLE_TARGET - 1),
      CLOCK_SYNC_PROBE_SPACING_MS,
    );

    expect(pair.a.view().phase).toBe("synchronizing");
    expect(pair.a.view().configHash).toBe(pair.b.view().configHash);

    advanceBoth(pair, RULES.network.retryMs);
    pair.bus.discardHeld(missingAck);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("ends neutrally when config acknowledgement retries cannot recover", () => {
    const onDesynchronization = vi.fn<(reason: string) => void>();
    const pair = createPair({ onADesynchronization: onDesynchronization });
    const heldAcks = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "CONFIG_ACK";
      },
    );
    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    pair.b.setReady(true);
    advanceBoth(
      pair,
      CLOCK_SYNC_PROBE_SPACING_MS * (CLOCK_SYNC_SAMPLE_TARGET - 1),
      CLOCK_SYNC_PROBE_SPACING_MS,
    );
    pair.b.disconnect();

    advanceBoth(pair, RULES.network.missingPeerMs);
    pair.bus.discardHeld(heldAcks);

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
      payload: {
        eventId: "b:cross:1",
        targetPlayerId: "player-a",
        crossVariant: "small",
      },
    });
    sendFromB({
      ...base,
      kind: "GLITCH_PIECE",
      seq: 5,
      payload: { eventId: "b:glitch:1", targetPlayerId: "player-a" },
    });
    sendFromB({
      ...base,
      kind: "OVERSIZE_PIECE",
      seq: 6,
      payload: { eventId: "b:oversize:1", targetPlayerId: "player-a" },
    });
    sendFromB({
      ...base,
      kind: "GHOST_JAM_START",
      seq: 7,
      payload: { eventId: "b:ghost-jam:1", targetPlayerId: "player-a" },
    });

    const local = pair.a.view().local;
    expect(local?.player.incomingGarbage).toHaveLength(1);
    expect(local?.player.incomingGarbage[0]?.rows).toBe(2);
    expect(local?.player.statuses).toContainEqual({
      kind: "scramble",
      remainingTicks: RULES.power.scrambleTicks,
    });
    expect(pair.a.isLocalScrambled()).toBe(true);
    expect(local?.player.statuses).toContainEqual({
      kind: "ghost-jam",
      remainingTicks: RULES.power.ghostJamTicks,
    });
    expect(local?.player.forcedQueue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "cross",
          eventId: "b:cross:1",
          crossVariant: "small",
        }),
        expect.objectContaining({ source: "oversize", eventId: "b:oversize:1" }),
      ]),
    );
    expect(onBlackout).toHaveBeenCalledWith("player-b", "b:blackout:1");
    expect(onIncomingGarbage).toHaveBeenCalledWith(2, "b:garbage:1");
    expect(onIncomingAttack.mock.calls).toEqual([
      ["garbage", "b:garbage:1", 2],
      ["scramble", "b:scramble:1"],
      ["blackout", "b:blackout:1"],
      ["hollow-cross", "b:cross:1"],
      ["glitch", "b:glitch:1"],
      ["oversize", "b:oversize:1"],
      ["ghost-jam", "b:ghost-jam:1"],
    ]);
  });

  it("converges mixed Cross variants after recovery and notifies overflow attacks", () => {
    const onIncomingAttack = vi.fn();
    const onIncomingGarbage = vi.fn();
    const pair = createPair({
      onAIncomingAttack: onIncomingAttack,
      onAIncomingGarbage: onIncomingGarbage,
    });
    ready(pair);
    advanceBoth(pair, 3_000);
    pair.a.setHidden(true);

    for (const [seq, eventId, crossVariant] of [
      [2, "b:cross:large", "large"],
      [3, "b:cross:small", "small"],
    ] as const) {
      pair.bEndpoint.send(encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-b",
        sessionId: "session-b",
        kind: "HOLLOW_CROSS",
        seq,
        matchTick: 0,
        sentAtMonotonicMs: pair.bClock.now(),
        payload: { eventId, targetPlayerId: "player-a", crossVariant },
      }));
    }

    expect(onIncomingAttack).not.toHaveBeenCalled();
    pair.a.setHidden(false);
    stabilizeRecovery(pair);

    const player = pair.a.view().local!.player;
    expect(player.forcedQueue).toEqual([
      expect.objectContaining({
        source: "cross",
        eventId: "b:cross:large",
        crossVariant: "large",
      }),
    ]);
    expect(player.incomingGarbage).toEqual([
      expect.objectContaining({ id: "b:cross:small:overflow", rows: 2 }),
    ]);
    expect(onIncomingAttack.mock.calls).toEqual([
      ["hollow-cross", "b:cross:large"],
      ["hollow-cross", "b:cross:small"],
    ]);
    expect(onIncomingGarbage).not.toHaveBeenCalled();
  });

  it("converts a second pending Oversize into source-timed warned garbage", () => {
    const onIncomingGarbage = vi.fn();
    const onIncomingAttack = vi.fn();
    const pair = createPair({
      onAIncomingGarbage: onIncomingGarbage,
      onAIncomingAttack: onIncomingAttack,
    });
    ready(pair);
    advanceBoth(pair, 3_500, 100);
    const sourceTick = Math.max(0, pair.a.view().matchTick - 5);

    for (const [seq, eventId] of [[1, "b:oversize:1"], [2, "b:oversize:2"]] as const) {
      pair.bEndpoint.send(encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-b",
        sessionId: "session-b",
        kind: "OVERSIZE_PIECE",
        seq,
        matchTick: sourceTick,
        sentAtMonotonicMs: pair.bClock.now(),
        payload: { eventId, targetPlayerId: "player-a" },
      }));
    }

    const local = pair.a.view().local?.player;
    expect(local?.forcedQueue).toEqual([
      expect.objectContaining({ source: "oversize", eventId: "b:oversize:1" }),
    ]);
    expect(local?.incomingGarbage).toContainEqual(expect.objectContaining({
      id: "b:oversize:2:overflow",
      rows: RULES.power.oversizeOverflowGarbageRows,
      readyTick: sourceTick + RULES.garbage.warningTicks,
      senderId: "player-b",
    }));
    expect(onIncomingAttack.mock.calls).toEqual([
      ["oversize", "b:oversize:1"],
      ["garbage", "b:oversize:2:overflow", RULES.power.oversizeOverflowGarbageRows],
    ]);
    expect(onIncomingGarbage).toHaveBeenCalledWith(
      RULES.power.oversizeOverflowGarbageRows,
      "b:oversize:2:overflow",
    );
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
    const onResult = vi.fn<(result: MatchResult) => void>();
    const diagnostics = new NetworkDiagnostics({ clock: new ManualClock(20_000) });
    const pair = createPair({
      aDiagnostics: diagnostics,
      onADesynchronization: onDesynchronization,
      onAResultConfirmed: onResult,
    });
    ready(pair);
    advanceBoth(pair, 3_000);
    const localTick = pair.a.view().matchTick;
    const remoteTick = localTick +
      Math.ceil(
        (RULES.network.maxRollbackMs * RULES.timing.ticksPerSecond) / 1_000,
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
    expect(diagnostics.snapshot().incidents[0]).toMatchObject({
      context: { matchId: "match-1", localSeat: "a" },
      events: [{
        kind: "desynchronized",
        reason: "remote-tick-out-of-range",
        remoteTick: {
          source: "network-pause",
          localTick,
          remoteTargetTick: remoteTick,
          maxAllowedDeltaTicks: remoteTick - localTick - 1,
        },
        telemetry: expect.any(Object),
      }],
    });
  });

  it("ignores stale restart proposal and commit frames after play has begun", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000);
    const remoteTick =
      pair.b.view().matchTick +
      Math.ceil(
        (RULES.network.maxRollbackMs * RULES.timing.ticksPerSecond) / 1_000,
      ) +
      1;

    pair.aEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-a",
        sessionId: "session-a",
        kind: "START",
        seq: 4,
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

    pair.aEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-a",
        sessionId: "session-a",
        kind: "START_COMMIT",
        seq: 5,
        matchTick: remoteTick,
        sentAtMonotonicMs: pair.aClock.now(),
        payload: {
          eventId: "a:unexpected-restart-commit",
          proposalEventId: "a:unexpected-restart",
          epoch: 0,
          startAtCoordinatorMs: pair.aClock.now() + 3_000,
          startTick: remoteTick,
          configHash: pair.a.view().configHash!,
        },
      }),
    );

    expect(pair.b.view().phase).toBe("playing");
    expect(pair.b.view().matchTick).toBe(0);
    expect(pair.b.view().result).toBeUndefined();
  });

  it("does not revive a terminal peer when stale start frames arrive", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000);
    const configHash = pair.a.view().configHash!;

    pair.a.forfeit();
    expect(pair.b.view().phase).toBe("finished");

    pair.aEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-a",
        sessionId: "session-a",
        kind: "START",
        seq: 5,
        matchTick: 0,
        sentAtMonotonicMs: pair.aClock.now(),
        payload: {
          eventId: "a:stale-terminal-start",
          epoch: 0,
          startAtCoordinatorMs: pair.aClock.now() + 3_000,
          startTick: 0,
          configHash,
        },
      }),
    );
    pair.aEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-a",
        sessionId: "session-a",
        kind: "START_COMMIT",
        seq: 6,
        matchTick: 0,
        sentAtMonotonicMs: pair.aClock.now(),
        payload: {
          eventId: "a:stale-terminal-start-commit",
          proposalEventId: "a:stale-terminal-start",
          epoch: 0,
          startAtCoordinatorMs: pair.aClock.now() + 3_000,
          startTick: 0,
          configHash,
        },
      }),
    );

    expect(pair.b.view()).toMatchObject({
      phase: "finished",
      terminal: { reason: "forfeit" },
    });
  });

  it("requires a start commit to match the stored epoch, tick, and config", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    pair.a.setHidden(true);
    const startTick = pair.b.view().matchTick;
    const configHash = pair.a.view().configHash!;

    // This test isolates START/START_COMMIT semantic matching. Mark the
    // current pause attachment synchronized so the generation gate does not
    // intentionally defer the manually injected recovery criticals.
    pair.aEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-a",
        sessionId: "session-a",
        kind: "CLOCK_COMMIT",
        matchTick: startTick,
        sentAtMonotonicMs: pair.aClock.now(),
        payload: {
          offsetPeerMinusCoordinatorMs: 25,
          sampleIds: [1, 2, 3],
        },
      }),
    );

    pair.aEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-a",
        sessionId: "session-a",
        kind: "START",
        seq: 5,
        matchTick: startTick,
        sentAtMonotonicMs: pair.aClock.now(),
        payload: {
          eventId: "a:manual-resume-start",
          epoch: 1,
          startAtCoordinatorMs: pair.aClock.now() + 2_000,
          startTick,
          configHash,
        },
      }),
    );
    pair.aEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-a",
        sessionId: "session-a",
        kind: "START_COMMIT",
        seq: 6,
        matchTick: startTick + 1,
        sentAtMonotonicMs: pair.aClock.now(),
        payload: {
          eventId: "a:mismatched-resume-start-commit",
          proposalEventId: "a:manual-resume-start",
          epoch: 1,
          startAtCoordinatorMs: pair.aClock.now() + 2_000,
          startTick: startTick + 1,
          configHash,
        },
      }),
    );
    expect(pair.b.view().phase).toBe("network-pause");

    pair.aEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-a",
        sessionId: "session-a",
        kind: "START_COMMIT",
        seq: 7,
        matchTick: startTick,
        sentAtMonotonicMs: pair.aClock.now(),
        payload: {
          eventId: "a:matching-resume-start-commit",
          proposalEventId: "a:manual-resume-start",
          epoch: 1,
          startAtCoordinatorMs: pair.aClock.now() + 2_000,
          startTick,
          configHash,
        },
      }),
    );

    expect(pair.b.view()).toMatchObject({
      phase: "countdown",
      matchTick: startTick,
    });
  });

  it("stops neutrally when a top-out contradicts its terminal snapshot hash", () => {
    const onDesynchronization = vi.fn<(reason: string) => void>();
    const onResult = vi.fn<(result: MatchResult) => void>();
    const diagnostics = new NetworkDiagnostics({ clock: new ManualClock(1_000) });
    const pair = createPair({
      onADesynchronization: onDesynchronization,
      onAResultConfirmed: onResult,
      aDiagnostics: diagnostics,
    });
    ready(pair);
    advanceBoth(pair, 3_000);
    const remote = pair.a.view().remote!;

    pair.bEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-b",
        sessionId: "observer-session-b",
        kind: "SNAPSHOT",
        matchTick: remote.stateTick,
        sentAtMonotonicMs: pair.bClock.now(),
        payload: remote,
      }),
    );
    pair.bEndpoint.send(
      encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-b",
        sessionId: "session-b",
        kind: "KEEPALIVE",
        matchTick: remote.stateTick,
        sentAtMonotonicMs: pair.bClock.now(),
        payload: {
          activeSessionId: "session-b",
          resumeAvailable: true,
          lastSnapshotSeq: remote.snapshotSeq + 4,
          inboundCritical: [],
        },
      }),
    );
    pair.aClock.advance(250);

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
    expect(diagnostics.snapshot().incidents[0]?.events).toEqual([
      expect.objectContaining({
        kind: "desynchronized",
        reason: "top-out-state-hash-mismatch",
        snapshotsAccepted: 1,
        snapshotsRejected: 1,
        lastSnapshotSeq: remote.snapshotSeq,
        lastSnapshotTick: remote.stateTick,
        lastSnapshotAgeMs: 250,
        peerLastSnapshotSeq: remote.snapshotSeq + 4,
        lastSnapshotRejection: "session-mismatch",
      }),
    ]);
    expect(onResult).toHaveBeenCalledOnce();
  });

  it("exchanges identical result confirmations and lets only Seat A publish a normal result", () => {
    const onAResult = vi.fn<(result: MatchResult) => void>();
    const onBResult = vi.fn<(result: MatchResult) => void>();
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
    const onAResult = vi.fn<(result: MatchResult) => void>();
    const pair = createPair({ onAResultConfirmed: onAResult });
    ready(pair);
    advanceBoth(pair, 3_000);

    for (let piece = 0; piece < 200 && pair.a.view().phase === "playing"; piece += 1) {
      pair.a.dispatch("hard-drop");
    }
    pair.bus.dropNext("runtime-b", "runtime-a");
    advanceBoth(pair, RULES.network.retryMs);
    expect(onAResult).not.toHaveBeenCalled();

    advanceBoth(pair, CRITICAL_INITIAL_RETRANSMIT_MS);
    expect(onAResult).toHaveBeenCalledTimes(1);
  });

  it("finishes neutrally when top-out result consensus cannot recover", () => {
    const onAResult = vi.fn<(result: MatchResult) => void>();
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
    const onAResult = vi.fn<(result: MatchResult) => void>();
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

    stabilizeRecovery(pair);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    advanceBoth(
      pair,
      (RULES.network.rollbackResumeCountdownTicks * 1_000) /
        RULES.timing.ticksPerSecond,
    );
    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    expect(pair.a.view().matchTick).toBe(frozenTick);
    expect(pair.b.view().matchTick).toBe(frozenTick);
  });

  it("reports the pre-adoption tick when a peer initiates rollback", () => {
    const diagnostics = new NetworkDiagnostics();
    const pair = createPair({ aDiagnostics: diagnostics });
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    pair.aClock.advance(1_000);
    pair.bClock.advance(1_000);
    pair.a.pump();
    const originalPauseTick = pair.a.view().matchTick;
    const peerProposedPauseTick = pair.b.view().matchTick;
    expect(originalPauseTick).toBeGreaterThan(peerProposedPauseTick);

    pair.b.setHidden(true);
    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      matchTick: peerProposedPauseTick,
    });
    pair.b.setHidden(false);
    stabilizeRecovery(pair);

    const resume = diagnostics.snapshot().incidents
      .flatMap((incident) => incident.events)
      .find((event) => event.kind === "resume-countdown");
    expect(resume?.rollback).toMatchObject({
      originalPauseTick,
      finalCommonTick: peerProposedPauseTick,
    });
  });

  it("does not let a hidden controller independently declare connection loss", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    const frozenTick = pair.a.view().matchTick;

    pair.a.setHidden(true);
    advanceBoth(pair, RULES.network.controllerReconnectGraceMs + 1_000, 1_000);

    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      matchTick: frozenTick,
      connectionStatus: "unstable",
    });
    expect(pair.a.view().terminal).toBeUndefined();
    expect(pair.b.view()).toMatchObject({
      phase: "finished",
      terminal: { outcome: "desync", reason: "connection-lost" },
    });
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
    stabilizeRecovery(pair);
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

  it("uses a short synchronized lead after a stable zero-rollback recovery", () => {
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
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");

    stabilizeRecovery(pair);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    expect(pair.a.view().countdownTicks).toBe(45);

    advanceBoth(pair, 750, 50);
    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    expect(pair.a.view().matchTick).toBe(frozenTick);
    expect(pair.b.view().matchTick).toBe(frozenTick);
  });

  it("extends a fast resume lead when clock probes observe a slow path", () => {
    const pair = createPair();
    const heldPongs = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "CLOCK_PONG";
      },
    );

    pair.a.start();
    pair.b.start();
    pair.a.setReady(true);
    pair.b.setReady(true);
    advanceBoth(pair, 600, CLOCK_SYNC_PROBE_SPACING_MS);
    pair.bus.releaseHeld(heldPongs);
    advanceBoth(pair, 1, 1);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    advanceBoth(
      pair,
      (RULES.network.initialStartCountdownTicks * 1_000) /
        RULES.timing.ticksPerSecond,
      50,
    );

    pair.b.setHidden(true);
    pair.b.setHidden(false);
    stabilizeRecovery(pair);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    expect(pair.a.view().countdownTicks).toBeGreaterThan(
      RULES.network.fastResumeCountdownTicks,
    );
    expect(pair.a.view().countdownTicks).toBeLessThanOrEqual(
      RULES.network.initialStartCountdownTicks,
    );
    expect(pair.a.view().countdownTicks).toBe(pair.b.view().countdownTicks);
  });

  it("creates a fresh commit lead after a restart proposal is delayed", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    pair.b.disconnect();
    advanceBoth(pair, RULES.network.missingPeerMs, 100);

    const heldStarts = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b-delayed-start",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "START";
      },
    );
    pair.b.attachTransport(pair.bus.connect("runtime-b-delayed-start"));
    advanceBoth(pair, 500, 50);

    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");

    advanceBoth(pair, 600, 50);
    pair.bus.releaseHeld(heldStarts);
    advanceBoth(pair, 1, 1);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    expect(pair.a.view().countdownTicks).toBe(pair.b.view().countdownTicks);
    expect(pair.a.view().countdownTicks).toBeGreaterThanOrEqual(30);
    expect(pair.a.view().countdownTicks).toBeLessThanOrEqual(45);
  });

  it("keeps both seats paused until a delayed restart proposal is committed", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    pair.b.disconnect();
    advanceBoth(pair, RULES.network.missingPeerMs, 100);

    const replacementId = "runtime-b-delayed-start-ack";
    const startEventIds: string[] = [];
    const commitEventIds: string[] = [];
    const observeStarts = pair.bus.holdMatching(
      "runtime-a",
      replacementId,
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (!decoded.ok) return false;
        if (decoded.value.kind === "START") {
          startEventIds.push(decoded.value.payload.eventId);
        } else if (decoded.value.kind === "START_COMMIT") {
          commitEventIds.push(decoded.value.payload.eventId);
        }
        return false;
      },
    );
    const heldProposalDeliveryProof = pair.bus.holdMatching(
      replacementId,
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return (
          decoded.ok &&
          (decoded.value.kind === "ACK" ||
            (decoded.value.kind === "KEEPALIVE" &&
              startEventIds.length > 0))
        );
      },
    );
    pair.b.attachTransport(pair.bus.connect(replacementId));
    stabilizeRecovery(pair);

    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");

    // More than the intended 750 ms lead may elapse while the prepare ACK is
    // delayed. Neither seat is allowed to start from that stale proposal.
    advanceBoth(pair, 800, 50);
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");
    expect(startEventIds.length).toBeGreaterThan(1);
    expect(new Set(startEventIds).size).toBe(1);
    expect(commitEventIds).toHaveLength(0);

    pair.bus.releaseHeld(heldProposalDeliveryProof);
    advanceBoth(pair, 1, 1);
    pair.bus.discardHeld(observeStarts);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    expect(new Set(commitEventIds).size).toBe(1);
    expect(pair.a.view().countdownTicks).toBe(pair.b.view().countdownTicks);
    expect(pair.a.view().countdownTicks).toBeGreaterThanOrEqual(30);
    expect(pair.a.view().countdownTicks).toBeLessThanOrEqual(45);

    advanceBoth(pair, 750, 50);
    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    expect(pair.a.view().matchTick).toBe(pair.b.view().matchTick);
  });

  it("uses resume-state progress when clock acknowledgement and start proof are lost", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    pair.b.disconnect();
    advanceBoth(pair, RULES.network.missingPeerMs, 100);

    const replacementId = "runtime-b-selective-resume-loss";
    let firstStartSequence: number | null = null;
    const startEventIds: string[] = [];
    const commitEventIds: string[] = [];
    const recoveryFrameEventIds: string[] = [];
    const observeRecoveryFrames = pair.bus.holdMatching(
      "runtime-a",
      replacementId,
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (!decoded.ok) return false;
        if (decoded.value.kind === "START") {
          firstStartSequence ??= decoded.value.seq ?? null;
          startEventIds.push(decoded.value.payload.eventId);
          recoveryFrameEventIds.push(decoded.value.payload.eventId);
        } else if (decoded.value.kind === "START_COMMIT") {
          commitEventIds.push(decoded.value.payload.eventId);
          recoveryFrameEventIds.push(decoded.value.payload.eventId);
        } else if (
          decoded.value.kind === "NETWORK_PAUSE" ||
          decoded.value.kind === "RESUME_STATE"
        ) {
          recoveryFrameEventIds.push(decoded.value.payload.eventId);
        }
        return false;
      },
    );
    const heldProgressProof = pair.bus.holdMatching(
      replacementId,
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (!decoded.ok) return false;
        if (decoded.value.kind === "CONFIG_ACK") return true;
        const startSequence = firstStartSequence;
        if (startSequence === null) return false;
        if (decoded.value.kind === "ACK") {
          return decoded.value.payload.seqs.includes(startSequence);
        }
        if (decoded.value.kind === "KEEPALIVE") {
          return decoded.value.payload.inboundCritical.some(
            (cursor) =>
              cursor.stream.senderId === "player-a" &&
              cursor.stream.sessionId === "session-a" &&
              cursor.contiguousThrough >= startSequence,
          );
        }
        return false;
      },
    );

    pair.b.attachTransport(pair.bus.connect(replacementId));
    stabilizeRecovery(pair);
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");
    expect(firstStartSequence).not.toBeNull();

    // The reliable resume state proves B processed CLOCK_COMMIT even though
    // every CONFIG_ACK remains withheld. Crossing the old five-second commit
    // deadline must not create a second proposal for the same pause epoch.
    advanceBoth(pair, RULES.network.missingPeerMs + 100, 50);
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");
    expect(new Set(startEventIds).size).toBe(1);
    expect(commitEventIds).toHaveLength(0);
    expect(new Set(recoveryFrameEventIds).size).toBeLessThanOrEqual(3);

    pair.bus.releaseHeld(heldProgressProof);
    advanceBoth(pair, 1, 1);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    expect(new Set(commitEventIds).size).toBe(1);

    advanceBoth(
      pair,
      (RULES.network.fastResumeCountdownTicks * 1_000) /
        RULES.timing.ticksPerSecond,
      50,
    );
    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    expect(pair.a.view().matchTick).toBe(pair.b.view().matchTick);

    const recoveryFramesAfterAcknowledgement = recoveryFrameEventIds.length;
    advanceBoth(pair, RULES.network.retryMs * 2, 50);
    pair.bus.discardHeld(observeRecoveryFrames);
    expect(recoveryFrameEventIds).toHaveLength(
      recoveryFramesAfterAcknowledgement,
    );
  });

  it("recovers a queued restart proposal after its first transport send throws", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    pair.a.setHidden(true);
    pair.a.disconnect();
    const replacement = throwNextKind(
      pair.bus.connect("runtime-a-throwing-start"),
      "START",
    );
    pair.a.attachTransport(replacement);
    pair.a.setHidden(false);

    expect(() => stabilizeRecovery(pair)).toThrow(
      "injected START send failure",
    );
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");

    advanceBoth(pair, RULES.network.retryMs, 50);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("still schedules the coordinator resume when its forced snapshot send throws", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    pair.a.setHidden(true);
    pair.a.disconnect();
    const base = pair.bus.connect("runtime-a-throwing-resume-snapshot");
    let snapshotFailureInjected = false;
    pair.a.attachTransport({
      setListener: (listener) => base.setListener(listener),
      send: (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (
          !snapshotFailureInjected &&
          decoded.ok &&
          decoded.value.kind === "SNAPSHOT"
        ) {
          snapshotFailureInjected = true;
          throw new Error("injected coordinator SNAPSHOT send failure");
        }
        base.send(data);
      },
      leave: () => base.leave(),
    });
    pair.a.setHidden(false);

    expect(() => stabilizeRecovery(pair)).not.toThrow();
    expect(snapshotFailureInjected).toBe(true);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("replays an accepted resume receipt after its forced snapshot and first ACK are lost", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    pair.b.setHidden(true);
    pair.b.disconnect();
    const replacementId = "runtime-b-throwing-resume-snapshot";
    const replacement = throwNextKind(
      pair.bus.connect(replacementId),
      "SNAPSHOT",
    );
    pair.b.attachTransport(replacement);

    let commitSequence: number | null = null;
    const observeCommit = pair.bus.holdMatching(
      "runtime-a",
      replacementId,
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "START_COMMIT") {
          commitSequence ??= decoded.value.seq ?? null;
        }
        return false;
      },
    );
    const lostCommitAcks = pair.bus.holdMatching(
      replacementId,
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        const sequence = commitSequence;
        return decoded.ok &&
          sequence !== null &&
          decoded.value.kind === "ACK" &&
          decoded.value.payload.seqs.includes(sequence);
      },
    );

    pair.b.setHidden(false);
    expect(() => stabilizeRecovery(pair)).not.toThrow();
    expect(commitSequence).not.toBeNull();
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("countdown");

    pair.bus.discardHeld(lostCommitAcks);
    advanceBoth(pair, CRITICAL_INITIAL_RETRANSMIT_MS * 2, 50);
    pair.bus.discardHeld(observeCommit);

    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    expect(pair.a.view().matchTick).toBe(pair.b.view().matchTick);
  });

  it("replaces an expired queued restart commit with a fresh shared lead", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    pair.a.setHidden(true);
    pair.a.disconnect();
    const replacement = throwNextKind(
      pair.bus.connect("runtime-a-throwing-start-commit"),
      "START_COMMIT",
    );
    pair.a.attachTransport(replacement);
    pair.a.setHidden(false);

    expect(() => stabilizeRecovery(pair)).toThrow(
      "injected START_COMMIT send failure",
    );
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");

    // Simulate the coordinator's event loop remaining stalled beyond the
    // intended lead. Delivery is acknowledged, but both seats discard the
    // expired semantic deadline and negotiate a fresh shared countdown.
    pair.aClock.advance(2_500);
    pair.bClock.advance(2_500);
    pair.a.pump();
    pair.b.pump();

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    expect(pair.a.view().countdownTicks).toBe(pair.b.view().countdownTicks);
    expect(pair.a.view().countdownTicks).toBeGreaterThanOrEqual(
      RULES.network.rollbackResumeCountdownTicks,
    );

    advanceBoth(
      pair,
      (RULES.network.initialStartCountdownTicks * 1_000) /
        RULES.timing.ticksPerSecond,
      50,
    );
    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    expect(pair.a.view().matchTick).toBe(pair.b.view().matchTick);
  });

  it("uses a longer orientation lead after rolling back to a common checkpoint", () => {
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
    for (
      let elapsed = 0;
      elapsed < RULES.network.missingPeerMs &&
        pair.a.view().phase !== "countdown";
      elapsed += 50
    ) {
      advanceBoth(pair, 50, 50);
    }

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
    expect(pair.a.view().countdownTicks).toBe(120);

    advanceBoth(pair, 2_000, 100);
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
      phase: "network-pause",
      matchTick: stalledTick,
    });
    expect(pair.b.view()).toMatchObject({
      phase: "desynchronized",
      terminal: { reason: "desynchronization" },
    });
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
      "OVERSIZE_PIECE",
      "SCRAMBLE_START",
      "GHOST_JAM_START",
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
    stabilizeRecovery(pair);
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
      "OVERSIZE_PIECE",
      "SCRAMBLE_START",
      "GHOST_JAM_START",
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
    stabilizeRecovery(pair);
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
      "OVERSIZE_PIECE",
      "SCRAMBLE_START",
      "GHOST_JAM_START",
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
    stabilizeRecovery(pair);

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
    stabilizeRecovery(pair);

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

  it("validates sustained bidirectional traffic before completing recovery", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    pair.aClock.advance(RULES.network.missingPeerMs);
    pair.bClock.advance(RULES.network.missingPeerMs);
    pair.a.pump();

    // One ACK begins resynchronization, but does not prove that the restored
    // path remains usable beyond a single synchronous burst.
    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      connectionStatus: "resynchronizing",
    });
    expect(pair.b.view().phase).toBe("network-pause");

    advanceBoth(pair, 499, 50);
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");

    advanceBoth(pair, 1, 1);
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");
    stabilizeRecovery(pair);
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
    stabilizeRecovery(pair);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it.each(["HELLO", "KEEPALIVE"] as const)(
    "does not let a stale resume-capable %s restart a hidden peer",
    (kind) => {
      const pair = createPair();
      const staleFrame = holdOneResumeCapableFrame(pair, kind);
      ready(pair);
      advanceBoth(pair, 3_600, 100);

      pair.b.setHidden(true);
      expect(pair.a.view().phase).toBe("network-pause");
      expect(pair.b.view().phase).toBe("network-pause");

      pair.bus.releaseHeld(staleFrame);
      advanceBoth(pair, RULES.network.keepaliveMs * 2, 50);

      expect(pair.a.view().phase).toBe("network-pause");
      expect(pair.b.view().phase).toBe("network-pause");
    },
  );

  it("recovers after becoming visible following a stale resume probe", () => {
    const pair = createPair();
    const staleKeepalive = holdOneResumeCapableFrame(pair, "KEEPALIVE");
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    pair.b.setHidden(true);
    pair.bus.releaseHeld(staleKeepalive);
    advanceBoth(pair, RULES.network.keepaliveMs * 2, 50);

    pair.b.setHidden(false);
    advanceBoth(
      pair,
      CLOCK_SYNC_RETRY_MAX_MS + RULES.network.recoveryStabilityMs,
      50,
    );
    stabilizeRecovery(pair);
    advanceBoth(pair, 1_000, 50);

    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
  });

  it("uses extended stability and one-hertz snapshots after a repeated pause", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000, 50);
    const interruptOutboundDelivery = (): void => {
      const blocked = pair.bus.holdMatching(
        "runtime-a",
        "runtime-b",
        () => true,
      );
      advanceBoth(pair, RULES.network.missingPeerMs + 100, 50);
      pair.bus.discardHeld(blocked);
      pair.a.setHidden(false);
      pair.b.setHidden(false);
      expect(pair.a.view().phase).toBe("network-pause");
      expect(pair.b.view().phase).toBe("network-pause");
    };

    interruptOutboundDelivery();
    stabilizeRecovery(pair);
    expect(pair.a.view().phase).toBe("countdown");
    advanceBoth(pair, 1_500, 50);
    expect(pair.a.view().phase).toBe("playing");

    interruptOutboundDelivery();
    advanceBoth(pair, RULES.network.recoveryStabilityMs, 50);
    expect(pair.a.view().phase).toBe("network-pause");

    advanceBoth(pair, 2_000, 50);
    stabilizeRecovery(pair);
    expect(pair.a.view()).toMatchObject({
      phase: "countdown",
      snapshotIntervalTicks: 60,
    });
    advanceBoth(pair, 2_500, 50);
    expect(pair.a.view()).toMatchObject({
      phase: "playing",
      snapshotIntervalTicks: 60,
    });
    advanceBoth(pair, 20_000, 50);
    expect(pair.a.view().snapshotIntervalTicks).toBe(60);
  });

  it("does not shorten degraded stability at the thirty-second boundary", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000, 50);
    const interruptOutboundDelivery = (): void => {
      const blocked = pair.bus.holdMatching(
        "runtime-a",
        "runtime-b",
        () => true,
      );
      advanceBoth(pair, RULES.network.missingPeerMs + 100, 50);
      pair.bus.discardHeld(blocked);
      pair.a.setHidden(false);
      pair.b.setHidden(false);
    };

    interruptOutboundDelivery();
    stabilizeRecovery(pair);
    advanceBoth(pair, 1_500, 50);
    expect(pair.a.view().phase).toBe("playing");

    interruptOutboundDelivery();
    const degradedStartedAtMs = pair.aClock.now();
    expect(pair.a.view().phase).toBe("network-pause");
    pair.a.setHidden(true);
    pair.b.setHidden(true);
    advanceBoth(pair, 29_200, 50);

    pair.a.setHidden(false);
    pair.b.setHidden(false);
    advanceBoth(pair, 200, 50);
    expect(pair.a.view().connectionStatus).toBe("resynchronizing");

    let boundaryClockPings = 0;
    const observeBoundaryPings = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "CLOCK_PING") {
          boundaryClockPings += 1;
        }
        return false;
      },
    );
    advanceBoth(
      pair,
      degradedStartedAtMs + 29_999 - pair.aClock.now(),
      50,
    );
    const pingsBeforeExpiry = boundaryClockPings;
    advanceBoth(pair, 101, 1);

    expect(pair.a.view().phase).toBe("network-pause");
    expect(boundaryClockPings).toBe(pingsBeforeExpiry);
    expect([null, 60]).toContain(pair.a.view().snapshotIntervalTicks);
    advanceBoth(pair, 2_000, 50);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    pair.bus.discardHeld(observeBoundaryPings);
  });

  it("does not treat a visibility pause as connection flapping", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000, 50);

    pair.a.setHidden(true);
    pair.a.setHidden(false);
    pair.b.setHidden(false);
    stabilizeRecovery(pair);
    expect(pair.a.view().phase).toBe("countdown");
    advanceBoth(pair, 2_100, 50);
    expect(pair.a.view().phase).toBe("playing");

    const blocked = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      () => true,
    );
    advanceBoth(pair, RULES.network.missingPeerMs + 100, 50);
    pair.bus.discardHeld(blocked);
    pair.a.setHidden(false);
    pair.b.setHidden(false);
    expect(pair.a.view().phase).toBe("network-pause");

    stabilizeRecovery(pair);
    expect(pair.a.view()).toMatchObject({
      phase: "countdown",
      snapshotIntervalTicks: 12,
    });
  });

  it("waits for bidirectional traffic on a replacement before recording peer return", () => {
    const diagnostics = new NetworkDiagnostics();
    const pair = createPair({ aDiagnostics: diagnostics });
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    pair.a.setHidden(true);
    pair.a.disconnect("replacement");
    const replacementId = "runtime-a-proof-gated";
    const heldInbound = pair.bus.holdMatching(
      "runtime-b",
      replacementId,
      () => true,
    );
    let resumePings = 0;
    const observePings = pair.bus.holdMatching(
      replacementId,
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "CLOCK_PING") resumePings += 1;
        return false;
      },
    );
    pair.a.attachTransport(pair.bus.connect(replacementId));
    pair.a.setHidden(false);
    pair.a.pump();

    expect(
      diagnostics.snapshot().incidents.flatMap((incident) => incident.events)
        .filter((event) => event.kind === "peer-traffic-restored"),
    ).toHaveLength(0);
    expect(resumePings).toBe(0);

    pair.bus.releaseHeld(heldInbound);
    // Replacement HELLO/KEEPALIVE frames consume the initial recovery burst;
    // the first clock probe follows in the next bounded control window.
    advanceBoth(pair, 300, 50);
    pair.bus.discardHeld(observePings);

    expect(
      diagnostics.snapshot().incidents.flatMap((incident) => incident.events)
        .filter((event) => event.kind === "peer-traffic-restored"),
    ).toHaveLength(1);
    expect(resumePings).toBeGreaterThan(0);
  });

  it("ignores a delayed callback from the departed transport generation", () => {
    const diagnostics = new NetworkDiagnostics();
    const pair = createPair({ aDiagnostics: diagnostics });
    pair.a.disconnect("replacement");
    const departed = retainOneProbeEchoCallback(
      pair.bus.connect("runtime-a-departed-callback"),
    );
    pair.a.attachTransport(departed.transport);
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    departed.arm();
    pair.aClock.advance(RULES.network.keepaliveMs);
    pair.bClock.advance(RULES.network.keepaliveMs);
    pair.a.pump();
    expect(departed.hasRetainedFrame()).toBe(true);

    pair.a.setHidden(true);
    pair.a.disconnect("replacement");
    const replacementId = "runtime-a-after-departed-callback";
    const heldCurrentInbound = pair.bus.holdMatching(
      "runtime-b",
      replacementId,
      () => true,
    );
    let resumePings = 0;
    const observeResumePings = pair.bus.holdMatching(
      replacementId,
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "CLOCK_PING") resumePings += 1;
        return false;
      },
    );
    pair.a.attachTransport(pair.bus.connect(replacementId));
    pair.a.setHidden(false);
    pair.a.pump();

    departed.invokeDepartedListener();

    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      connectionStatus: "unstable",
    });
    expect(resumePings).toBe(0);
    expect(
      diagnostics.snapshot().incidents.flatMap((incident) => incident.events)
        .filter((event) => event.kind === "peer-traffic-restored"),
    ).toHaveLength(0);
    pair.bus.discardHeld(observeResumePings);
    pair.bus.discardHeld(heldCurrentInbound);
  });

  it("does not accept an old probe response through the current transport", () => {
    const diagnostics = new NetworkDiagnostics();
    const pair = createPair({ aDiagnostics: diagnostics });
    pair.a.disconnect("replacement");
    const departed = retainOneProbeEchoCallback(
      pair.bus.connect("runtime-a-old-proof-frame"),
    );
    pair.a.attachTransport(departed.transport);
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    departed.arm();
    pair.aClock.advance(RULES.network.keepaliveMs);
    pair.bClock.advance(RULES.network.keepaliveMs);
    pair.a.pump();
    expect(departed.hasRetainedFrame()).toBe(true);

    pair.a.setHidden(true);
    pair.a.disconnect("replacement");
    const replacementId = "runtime-a-current-proof-frame";
    const heldCurrentInbound = pair.bus.holdMatching(
      "runtime-b",
      replacementId,
      () => true,
    );
    let currentListener: ((data: Uint8Array) => void) | null = null;
    const endpoint = pair.bus.connect(replacementId);
    pair.a.attachTransport({
      setListener: (listener) => {
        currentListener = listener;
        endpoint.setListener(listener);
      },
      send: (data) => endpoint.send(data),
      leave: () => endpoint.leave(),
    });
    pair.a.setHidden(false);
    pair.a.pump();

    if (currentListener === null) throw new Error("Current listener missing");
    (currentListener as (data: Uint8Array) => void)(departed.retainedFrame());

    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      connectionStatus: "unstable",
    });
    expect(
      diagnostics.snapshot().incidents.flatMap((incident) => incident.events)
        .filter((event) => event.kind === "peer-traffic-restored"),
    ).toHaveLength(0);
    pair.bus.discardHeld(heldCurrentInbound);
  });

  it("does not accept an old critical acknowledgement through the current transport", () => {
    const diagnostics = new NetworkDiagnostics();
    const pair = createPair({ aDiagnostics: diagnostics });
    pair.a.disconnect("replacement");
    const departed = retainOneCriticalAck(
      pair.bus.connect("runtime-a-old-critical-ack"),
    );
    pair.a.attachTransport(departed.transport);
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    departed.arm();
    pair.a.setHidden(true);
    expect(departed.hasRetainedFrame()).toBe(true);

    pair.a.disconnect("replacement");
    const replacementId = "runtime-a-current-critical-ack";
    const heldCurrentInbound = pair.bus.holdMatching(
      "runtime-b",
      replacementId,
      () => true,
    );
    let currentListener: ((data: Uint8Array) => void) | null = null;
    const endpoint = pair.bus.connect(replacementId);
    pair.a.attachTransport({
      setListener: (listener) => {
        currentListener = listener;
        endpoint.setListener(listener);
      },
      send: (data) => endpoint.send(data),
      leave: () => endpoint.leave(),
    });
    pair.a.setHidden(false);

    if (currentListener === null) throw new Error("Current listener missing");
    (currentListener as (data: Uint8Array) => void)(departed.retainedFrame());

    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      connectionStatus: "unstable",
    });
    expect(
      diagnostics.snapshot().incidents.flatMap((incident) => incident.events)
        .filter((event) => event.kind === "peer-traffic-restored"),
    ).toHaveLength(0);
    pair.bus.discardHeld(heldCurrentInbound);
  });

  it("only accepts a direct acknowledgement for the exact current pause", () => {
    const diagnostics = new NetworkDiagnostics();
    const pair = createPair({ aDiagnostics: diagnostics });
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    const pauseFrames: RealtimeEnvelope<"NETWORK_PAUSE">[] = [];
    const observePauses = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "NETWORK_PAUSE") {
          pauseFrames.push(decoded.value);
        }
        return false;
      },
    );
    const withheldPeerTraffic = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      () => true,
    );

    pair.aClock.advance(RULES.network.missingPeerMs);
    pair.bClock.advance(RULES.network.missingPeerMs);
    pair.a.pump();
    expect(pauseFrames).toHaveLength(1);
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");
    const oldPause = pauseFrames[0]!;

    // A visibility transition while already paused creates a new recovery
    // epoch, but the first pause remains pending in the reliable outbox.
    pair.a.setHidden(true);
    expect(pauseFrames).toHaveLength(2);
    const currentPause = pauseFrames[1]!;
    expect(currentPause.payload.eventId).not.toBe(oldPause.payload.eventId);
    expect(currentPause.payload.pauseEpoch).toBeGreaterThan(
      oldPause.payload.pauseEpoch,
    );

    pair.aClock.advance(CRITICAL_INITIAL_RETRANSMIT_MS);
    pair.bClock.advance(CRITICAL_INITIAL_RETRANSMIT_MS);
    pair.a.pump();
    expect(
      pauseFrames.filter(
        (frame) => frame.payload.eventId === oldPause.payload.eventId,
      ),
    ).toHaveLength(2);

    pair.a.setHidden(false);
    pair.bus.discardHeld(withheldPeerTraffic);
    let permittedAckSequence: number | null = null;
    const isolateDirectAcks = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (
          permittedAckSequence !== null &&
          decoded.ok &&
          decoded.value.kind === "ACK" &&
          decoded.value.payload.seqs.length === 1 &&
          decoded.value.payload.seqs[0] === permittedAckSequence
        ) {
          permittedAckSequence = null;
          return false;
        }
        return true;
      },
    );
    const injectDirectAck = (sequence: number): void => {
      permittedAckSequence = sequence;
      pair.bEndpoint.send(encodeEnvelope({
        protocol: 1,
        matchId: "match-1",
        senderId: "player-b",
        sessionId: "session-b",
        kind: "ACK",
        matchTick: pair.b.view().matchTick,
        sentAtMonotonicMs: pair.bClock.now(),
        payload: {
          stream: { senderId: "player-a", sessionId: "session-a" },
          seqs: [sequence],
        },
      }));
      expect(permittedAckSequence).toBeNull();
    };
    if (oldPause.seq === undefined || currentPause.seq === undefined) {
      throw new Error("Reliable pause sequence missing");
    }

    // The first event was retransmitted on this transport generation, so only
    // the exact pause event identity prevents its delayed ACK proving recovery.
    injectDirectAck(oldPause.seq);
    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      connectionStatus: "unstable",
    });
    expect(
      diagnostics.snapshot().incidents.flatMap((incident) => incident.events)
        .filter((event) => event.kind === "peer-traffic-restored"),
    ).toHaveLength(0);

    // With every cursor, probe echo, and clock pong still isolated, the direct
    // ACK for this epoch's pause is sufficient positive recovery proof.
    injectDirectAck(currentPause.seq);
    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      connectionStatus: "resynchronizing",
    });
    expect(
      diagnostics.snapshot().incidents.flatMap((incident) => incident.events)
        .filter((event) => event.kind === "peer-traffic-restored"),
    ).toHaveLength(1);

    pair.bus.discardHeld(isolateDirectAcks);
    pair.bus.discardHeld(observePauses);
  });

  it("invalidates an in-flight resume when the coordinator becomes hidden", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    pair.b.setHidden(true);
    const heldPongs = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "CLOCK_PONG";
      },
    );
    pair.b.setHidden(false);
    expect(pair.a.view().phase).toBe("network-pause");

    pair.a.setHidden(true);
    pair.bus.releaseHeld(heldPongs);
    advanceBoth(pair, RULES.network.keepaliveMs * 2, 50);

    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");

    pair.a.setHidden(false);
    stabilizeRecovery(pair);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("requires fresh outbound proof after adopting a higher pause epoch", () => {
    const diagnostics = new NetworkDiagnostics();
    const pair = createPair({ aDiagnostics: diagnostics });
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    pair.b.setHidden(true);
    const heldPongs = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "CLOCK_PONG";
      },
    );
    pair.b.setHidden(false);
    advanceBoth(pair, 100, 50);
    expect(pair.a.view().connectionStatus).toBe("resynchronizing");

    let postEpochClockPings = 0;
    const blockedFreshOutbound = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "CLOCK_PING") {
          postEpochClockPings += 1;
        }
        return true;
      },
    );

    pair.b.setHidden(true);
    postEpochClockPings = 0;
    pair.b.setHidden(false);
    advanceBoth(pair, RULES.network.keepaliveMs + 300, 50);

    expect(postEpochClockPings).toBe(0);
    expect(
      diagnostics.snapshot().incidents.flatMap((incident) => incident.events)
        .filter((event) => event.kind === "peer-traffic-restored"),
    ).toHaveLength(1);

    pair.bus.discardHeld(blockedFreshOutbound);
    pair.bus.discardHeld(heldPongs);
  });

  it("retries the immediate peer-pause probe when its first delivery is lost", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    let droppedImmediateProbe = false;
    const firstProbe = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (
          droppedImmediateProbe ||
          !decoded.ok ||
          decoded.value.kind !== "KEEPALIVE"
        ) return false;
        droppedImmediateProbe = true;
        return true;
      },
    );

    pair.b.setHidden(true);
    expect(droppedImmediateProbe).toBe(true);
    pair.bus.discardHeld(firstProbe);
    pair.b.setHidden(false);

    advanceBoth(pair, RULES.network.keepaliveMs, 50);
    stabilizeRecovery(pair);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("retries resume clock sync once before replacing a proven channel", () => {
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
    expect(onRecoveryNeeded).not.toHaveBeenCalled();

    advanceBoth(pair, RULES.network.missingPeerMs, 100);
    expect(onRecoveryNeeded).toHaveBeenCalledTimes(1);
    pair.bus.releaseHeld(pongHold);
    advanceBoth(pair, RULES.network.recoveryStabilityMs * 2, 50);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("requires fresh bidirectional proof after replacement during clock sync", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    pair.b.setHidden(true);
    const oldPongs = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "CLOCK_PONG";
      },
    );
    pair.b.setHidden(false);
    advanceBoth(pair, 100, 50);
    expect(pair.a.view().connectionStatus).toBe("resynchronizing");

    pair.a.disconnect("replacement");
    const replacementId = "runtime-a-mid-sync-replacement";
    const heldReplacementInbound = pair.bus.holdMatching(
      "runtime-b",
      replacementId,
      () => true,
    );
    let replacementPings = 0;
    const observeReplacementPings = pair.bus.holdMatching(
      replacementId,
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "CLOCK_PING") {
          replacementPings += 1;
        }
        return false;
      },
    );
    pair.a.attachTransport(pair.bus.connect(replacementId));

    advanceBoth(pair, RULES.network.recoveryStabilityMs, 50);
    expect(replacementPings).toBe(0);
    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      connectionStatus: "unstable",
    });

    pair.bus.releaseHeld(heldReplacementInbound);
    advanceBoth(pair, 100, 50);
    expect(replacementPings).toBeGreaterThan(0);
    pair.bus.discardHeld(observeReplacementPings);
    pair.bus.discardHeld(oldPongs);
    stabilizeRecovery(pair);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("continues a prepared resume only after replacement synchronization", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    const oldStartEventIds: string[] = [];
    const heldOldStarts = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (
          decoded.ok &&
          decoded.value.kind === "START" &&
          decoded.value.payload.epoch > 0
        ) {
          oldStartEventIds.push(decoded.value.payload.eventId);
          return true;
        }
        return false;
      },
    );
    pair.b.setHidden(true);
    pair.b.setHidden(false);
    advanceBoth(pair, 2_000, 50);

    expect(new Set(oldStartEventIds).size).toBe(1);
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");

    pair.a.disconnect("replacement");
    const replacementId = "runtime-a-after-prepared-resume";
    const heldReplacementInbound = pair.bus.holdMatching(
      "runtime-b",
      replacementId,
      () => true,
    );
    const replacementHandshake: Array<
      RealtimeEnvelope<"RESUME_STATE" | "START" | "START_COMMIT">
    > = [];
    const observeReplacement = pair.bus.holdMatching(
      replacementId,
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (
          decoded.ok &&
          (decoded.value.kind === "RESUME_STATE" ||
            decoded.value.kind === "START" ||
            decoded.value.kind === "START_COMMIT")
        ) {
          replacementHandshake.push(decoded.value);
        }
        return false;
      },
    );
    pair.a.attachTransport(pair.bus.connect(replacementId));

    advanceBoth(pair, 1_500, 50);
    expect(replacementHandshake).toHaveLength(0);

    const heldReplacementPongs = pair.bus.holdMatching(
      "runtime-b",
      replacementId,
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "CLOCK_PONG";
      },
    );
    pair.bus.releaseHeld(heldReplacementInbound);
    advanceBoth(pair, RULES.network.missingPeerMs + 100, 50);
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");

    // The first current-generation sync times out, but its same-channel retry
    // must retain the prepared reliable START rather than orphaning the peer's
    // matching resume progress.
    pair.bus.discardHeld(heldReplacementPongs);
    advanceBoth(pair, 5_000, 50);
    pair.bus.discardHeld(observeReplacement);
    pair.bus.discardHeld(heldOldStarts);

    const replacementStarts = replacementHandshake.filter(
      (envelope) => envelope.kind === "START",
    );
    expect(new Set(replacementStarts.map(
      (envelope) => envelope.payload.eventId,
    ))).toEqual(new Set([oldStartEventIds[0]]));
    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    expect(pair.a.view().matchTick).toBe(pair.b.view().matchTick);
  });

  it("defers a pending resume commit received before replacement synchronization", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    let capturedCommit: Uint8Array | null = null;
    const heldOldCommits = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (
          decoded.ok &&
          decoded.value.kind === "START_COMMIT" &&
          decoded.value.payload.epoch > 0
        ) {
          capturedCommit ??= data.slice();
          return true;
        }
        return false;
      },
    );
    pair.b.setHidden(true);
    pair.b.setHidden(false);
    advanceBoth(pair, 2_000, 50);

    expect(capturedCommit).not.toBeNull();
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");

    pair.b.disconnect("replacement");
    const replacementId = "runtime-b-before-resume-commit";
    const heldReplacementInbound = pair.bus.holdMatching(
      "runtime-a",
      replacementId,
      () => true,
    );
    const endpoint = pair.bus.connect(replacementId);
    let currentListener: ((data: Uint8Array) => void) | null = null;
    pair.b.attachTransport({
      setListener: (listener) => {
        currentListener = listener;
        endpoint.setListener(listener);
      },
      send: (data) => endpoint.send(data),
      leave: () => endpoint.leave(),
    });

    if (currentListener === null || capturedCommit === null) {
      throw new Error("Pending commit replacement setup failed");
    }
    (currentListener as (data: Uint8Array) => void)(capturedCommit);
    expect(pair.b.view()).toMatchObject({
      phase: "network-pause",
      connectionStatus: "unstable",
    });

    pair.bus.releaseHeld(heldReplacementInbound);
    advanceBoth(pair, 5_000, 50);
    pair.bus.discardHeld(heldOldCommits);

    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    expect(pair.a.view().matchTick).toBe(pair.b.view().matchTick);
  });

  it("ignores a delayed duplicate hello from the current peer generation", () => {
    const pair = createPair();
    let capturedHello: Uint8Array | null = null;
    const observeHello = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "HELLO") {
          capturedHello ??= data.slice();
        }
        return false;
      },
    );
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    expect(capturedHello).not.toBeNull();

    const heldResumeStarts = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return (
          decoded.ok &&
          decoded.value.kind === "START" &&
          decoded.value.payload.epoch > 0
        );
      },
    );
    pair.b.setHidden(true);
    pair.b.setHidden(false);
    advanceBoth(pair, 2_000, 50);
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");

    if (capturedHello === null) throw new Error("Initial HELLO was not captured");
    pair.aEndpoint.send(capturedHello);
    pair.bus.releaseHeld(heldResumeStarts);
    advanceBoth(pair, 5_000, 50);
    pair.bus.discardHeld(observeHello);

    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");
    expect(pair.a.view().matchTick).toBe(pair.b.view().matchTick);
  });

  it("does not clock-sync a silent replacement after the bounded retry", () => {
    let pair!: ReturnType<typeof createPair>;
    const replacementId = "runtime-a-silent-clock-replacement";
    let heldReplacementInbound = 0;
    let replacementPings = 0;
    let observeReplacementPings = 0;
    const onRecoveryNeeded = vi.fn<() => void>(() => {
      pair.a.disconnect("replacement");
      heldReplacementInbound = pair.bus.holdMatching(
        "runtime-b",
        replacementId,
        () => true,
      );
      observeReplacementPings = pair.bus.holdMatching(
        replacementId,
        "runtime-b",
        (data) => {
          const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
          if (decoded.ok && decoded.value.kind === "CLOCK_PING") {
            replacementPings += 1;
          }
          return false;
        },
      );
      pair.a.attachTransport(pair.bus.connect(replacementId));
    });
    pair = createPair({ onATransportRecoveryNeeded: onRecoveryNeeded });
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    pair.b.setHidden(true);
    const heldPongs = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "CLOCK_PONG";
      },
    );

    pair.b.setHidden(false);
    advanceBoth(pair, RULES.network.missingPeerMs * 2, 100);

    expect(onRecoveryNeeded).toHaveBeenCalledTimes(1);
    expect(replacementPings).toBe(0);

    pair.bus.releaseHeld(heldReplacementInbound);
    advanceBoth(pair, 100, 50);
    pair.bus.discardHeld(observeReplacementPings);
    pair.bus.discardHeld(heldPongs);
    expect(replacementPings).toBeGreaterThan(0);
  });

  it("retries every staged resume clock sample after the first ping send throws", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);

    pair.a.setHidden(true);
    pair.a.disconnect();
    const replacement = throwNextKind(
      pair.bus.connect("runtime-a-throwing-clock-ping"),
      "CLOCK_PING",
    );
    pair.a.attachTransport(replacement);

    expect(() => pair.a.setHidden(false)).not.toThrow();
    let thrown: unknown;
    for (let elapsed = 0; elapsed < 1_000 && thrown === undefined; elapsed += 50) {
      pair.aClock.advance(50);
      pair.bClock.advance(50);
      try {
        pair.b.pump();
        pair.a.pump();
      } catch (error) {
        thrown = error;
      }
    }
    expect(thrown).toEqual(new Error("injected CLOCK_PING send failure"));
    expect(pair.a.view().phase).toBe("network-pause");

    advanceBoth(
      pair,
      RULES.network.retryMs + RULES.network.recoveryStabilityMs,
      50,
    );
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
    advanceBoth(pair, RULES.network.reconnectingMs, 100);

    expect(pair.a.view().phase).toBe("network-pause");
    expect(onRecoveryNeeded).toHaveBeenCalled();
    pair.bus.releaseHeld(commitHold);
    stabilizeRecovery(pair);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("ends a partial-traffic resume incident at its absolute controller deadline", () => {
    const pair = createPair();
    let clockPingsSent = 0;
    const observePings = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "CLOCK_PING") {
          clockPingsSent += 1;
        }
        return false;
      },
    );
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    pair.b.setHidden(true);
    pair.bus.holdMatching("runtime-b", "runtime-a", (data) => {
      const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
      return decoded.ok && decoded.value.kind === "CLOCK_PONG";
    });

    pair.b.setHidden(false);
    advanceBoth(pair, RULES.network.controllerReconnectGraceMs, 1_000);

    expect(pair.a.view()).toMatchObject({
      phase: "finished",
      connectionStatus: "lost",
      terminal: { outcome: "desync", reason: "connection-lost" },
    });

    const terminalClockPingsSent = clockPingsSent;
    advanceBoth(
      pair,
      RULES.network.missingPeerMs + CLOCK_SYNC_RETRY_MAX_MS,
      100,
    );
    pair.bus.discardHeld(observePings);

    expect(clockPingsSent).toBe(terminalClockPingsSent);
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

  it("pauses when outbound delivery loses every probe despite healthy inbound keepalives", () => {
    const diagnostics = new NetworkDiagnostics();
    const pair = createPair({ aDiagnostics: diagnostics });
    ready(pair);
    advanceBoth(pair, 3_000, 50);
    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");

    const blockedOutbound = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      () => true,
    );
    const blockedPeerPause = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "NETWORK_PAUSE";
      },
    );

    advanceBoth(
      pair,
      RULES.network.missingPeerMs + RULES.network.keepaliveMs + 250,
      50,
    );

    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");
    expect(diagnostics.snapshot().incidents[0]?.events[0]).toMatchObject({
      kind: "connection-unstable",
      pauseTrigger: "local-delivery-failure",
      telemetry: expect.any(Object),
    });

    pair.bus.discardHeld(blockedOutbound);
    pair.bus.discardHeld(blockedPeerPause);
  });

  it("accepts advancing snapshot cursors as outbound proof when probe echoes are lost", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000, 50);
    const blockedProbeEchoes = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok &&
          decoded.value.kind === "KEEPALIVE" &&
          decoded.value.payload.echoProbeSeq !== undefined &&
          decoded.value.payload.probeSeq === undefined;
      },
    );

    advanceBoth(
      pair,
      RULES.network.missingPeerMs + RULES.network.keepaliveMs,
      50,
    );
    pair.bus.discardHeld(blockedProbeEchoes);

    expect(pair.a.view().phase).toBe("playing");
    expect(pair.a.view().connectionStatus).toBe("connected");
  });

  it("sheds periodic snapshots at the outbound warning while preserving forced state", () => {
    const diagnostics = new NetworkDiagnostics();
    const pair = createPair({ aDiagnostics: diagnostics });
    ready(pair);
    advanceBoth(pair, 3_000, 50);
    let sentSnapshots = 0;
    const blockedOutbound = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "SNAPSHOT") sentSnapshots += 1;
        return true;
      },
    );

    advanceBoth(
      pair,
      RULES.network.unstablePeerMs + RULES.network.keepaliveMs + 100,
      50,
    );
    expect(pair.a.view()).toMatchObject({
      phase: "playing",
      snapshotIntervalTicks: null,
    });
    const periodicAtWarning = sentSnapshots;
    advanceBoth(pair, 500, 50);
    expect(sentSnapshots).toBe(periodicAtWarning);

    pair.bEndpoint.send(encodeEnvelope({
      protocol: 1,
      matchId: "match-1",
      senderId: "player-b",
      sessionId: "session-b",
      kind: "STATE_REQUEST",
      matchTick: pair.b.view().matchTick,
      sentAtMonotonicMs: pair.bClock.now(),
      payload: { targetPlayerIds: ["player-a"] },
    }));
    expect(sentSnapshots).toBe(periodicAtWarning + 1);

    advanceBoth(pair, RULES.network.missingPeerMs, 50);
    expect(
      diagnostics.snapshot().incidents[0]?.events[0]?.telemetry?.snapshots,
    ).toMatchObject({ activeIntervalTicks: null });
    pair.bus.discardHeld(blockedOutbound);
  });

  it("budgets optional recovery keepalives while clock probes are in flight", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000, 50);
    pair.b.setHidden(true);
    let probeKeepalives = 0;
    let recoveryControlFrames = 0;
    const recoveryWindowStartedAtMs = pair.aClock.now();
    const recoveryFramesByWindow = new Map<number, number>();
    const observeKeepalives = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind !== "SNAPSHOT") {
          const window = Math.floor(
            (pair.aClock.now() - recoveryWindowStartedAtMs) / 250,
          );
          recoveryFramesByWindow.set(
            window,
            (recoveryFramesByWindow.get(window) ?? 0) + 1,
          );
        }
        if (
          decoded.ok &&
          (decoded.value.kind === "KEEPALIVE" ||
            decoded.value.kind === "CLOCK_PING")
        ) recoveryControlFrames += 1;
        if (
          decoded.ok &&
          decoded.value.kind === "KEEPALIVE" &&
          decoded.value.payload.probeSeq !== undefined
        ) probeKeepalives += 1;
        return false;
      },
    );
    const heldPongs = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        return decoded.ok && decoded.value.kind === "CLOCK_PONG";
      },
    );

    pair.b.setHidden(false);
    advanceBoth(pair, 2_000, 50);
    pair.bus.discardHeld(observeKeepalives);
    pair.bus.discardHeld(heldPongs);

    expect(probeKeepalives).toBeGreaterThan(0);
    expect(probeKeepalives).toBeLessThanOrEqual(5);
    expect(recoveryControlFrames).toBeLessThanOrEqual(18);
    expect(Math.max(...recoveryFramesByWindow.values())).toBeLessThanOrEqual(4);
  });

  it("keeps a completed recovery handshake inside each sender control window", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000, 50);
    const startedAtA = pair.aClock.now();
    const startedAtB = pair.bClock.now();
    const framesByWindow = new Map<string, number>();
    const observe = (
      from: string,
      to: string,
      side: "a" | "b",
    ): number => pair.bus.holdMatching(from, to, (data) => {
      const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
      if (!decoded.ok || decoded.value.kind === "SNAPSHOT") return false;
      const now = side === "a" ? pair.aClock.now() : pair.bClock.now();
      const startedAt = side === "a" ? startedAtA : startedAtB;
      const key = `${side}:${Math.floor((now - startedAt) / 250)}`;
      framesByWindow.set(key, (framesByWindow.get(key) ?? 0) + 1);
      return false;
    });
    const fromA = observe("runtime-a", "runtime-b", "a");
    const fromB = observe("runtime-b", "runtime-a", "b");

    pair.b.setHidden(true);
    pair.b.setHidden(false);
    stabilizeRecovery(pair);

    pair.bus.discardHeld(fromA);
    pair.bus.discardHeld(fromB);
    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
    expect(Math.max(...framesByWindow.values())).toBeLessThanOrEqual(4);
  });

  it("allows requested forced state through a saturated recovery window", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000, 50);
    let pauseFrame: Uint8Array | null = null;
    const capturePause = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "NETWORK_PAUSE") {
          pauseFrame = data.slice();
        }
        return false;
      },
    );
    pair.b.setHidden(true);
    pair.bus.discardHeld(capturePause);
    if (pauseFrame === null) throw new Error("Expected a peer pause frame");

    pair.aClock.advance(250);
    pair.bClock.advance(250);
    for (let duplicate = 0; duplicate < 10; duplicate += 1) {
      pair.bEndpoint.send((pauseFrame as Uint8Array).slice());
    }
    let forcedSnapshots = 0;
    const observeSnapshot = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "SNAPSHOT") {
          forcedSnapshots += 1;
        }
        return false;
      },
    );
    pair.bEndpoint.send(encodeEnvelope({
      protocol: 1,
      matchId: "match-1",
      senderId: "player-b",
      sessionId: "session-b",
      kind: "STATE_REQUEST",
      matchTick: pair.b.view().matchTick,
      sentAtMonotonicMs: pair.bClock.now(),
      payload: { targetPlayerIds: ["player-a"] },
    }));
    pair.bus.discardHeld(observeSnapshot);

    expect(pair.a.view().phase).toBe("network-pause");
    expect(forcedSnapshots).toBe(1);
  });

  it("caps duplicate critical acknowledgements in the shared recovery window", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000, 50);
    let pauseFrame: Uint8Array | null = null;
    const capturePause = pair.bus.holdMatching(
      "runtime-b",
      "runtime-a",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "NETWORK_PAUSE") {
          pauseFrame = data.slice();
        }
        return false;
      },
    );

    pair.b.setHidden(true);
    pair.bus.discardHeld(capturePause);
    if (pauseFrame === null) throw new Error("Expected a reliable pause frame");
    advanceBoth(pair, 250, 50);

    let acknowledgements = 0;
    const observeAcks = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "ACK") acknowledgements += 1;
        return false;
      },
    );
    for (let duplicate = 0; duplicate < 10; duplicate += 1) {
      pair.bEndpoint.send((pauseFrame as Uint8Array).slice());
    }
    const immediateAcknowledgements = acknowledgements;
    expect(acknowledgements).toBeGreaterThan(0);
    expect(acknowledgements).toBeLessThanOrEqual(4);

    advanceBoth(pair, 250, 50);
    pair.bus.discardHeld(observeAcks);
    expect(acknowledgements).toBe(immediateAcknowledgements + 1);
  });

  it("coalesces a queued recovery probe with the latest required echo", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000, 50);
    pair.a.setHidden(true);
    pair.aClock.advance(1_000);
    pair.bClock.advance(1_000);

    const peerPause: RealtimeEnvelope<"NETWORK_PAUSE"> = {
      protocol: 1,
      matchId: "match-1",
      senderId: "player-b",
      sessionId: "session-b",
      kind: "NETWORK_PAUSE",
      seq: 1,
      matchTick: pair.a.view().matchTick,
      sentAtMonotonicMs: pair.bClock.now(),
      payload: {
        eventId: "peer-pause-for-keepalive-coalescing",
        pauseEpoch: 2,
        proposedPauseTick: pair.a.view().matchTick,
        connectionIssue: false,
      },
    };
    for (let duplicate = 0; duplicate < 10; duplicate += 1) {
      pair.bEndpoint.send(encodeEnvelope(peerPause));
    }

    // The duplicate ACK burst has filled A's current window. Unhiding queues
    // A's newest probe, then the peer's fresh probe queues an echo with the
    // same coalescing key. The eventual frame must retain both obligations.
    pair.a.setHidden(false);
    const peerProbeSeq = 0x7fff_0000;
    pair.bEndpoint.send(encodeEnvelope({
      protocol: 1,
      matchId: "match-1",
      senderId: "player-b",
      sessionId: "session-b",
      kind: "KEEPALIVE",
      matchTick: pair.b.view().matchTick,
      sentAtMonotonicMs: pair.bClock.now(),
      payload: {
        activeSessionId: "session-b",
        resumeAvailable: false,
        lastSnapshotSeq: 0,
        probeSeq: peerProbeSeq,
        inboundCritical: [],
      },
    }));
    const keepalives: Array<RealtimeEnvelope<"KEEPALIVE">> = [];
    const observer = pair.bus.holdMatching(
      "runtime-a",
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "KEEPALIVE") {
          keepalives.push(decoded.value);
        }
        return false;
      },
    );

    advanceBoth(pair, 250, 50);
    pair.bus.discardHeld(observer);

    const merged = keepalives.find(
      (frame) => frame.payload.echoProbeSeq === peerProbeSeq,
    );
    expect(merged?.payload).toMatchObject({
      resumeAvailable: true,
      echoProbeSeq: peerProbeSeq,
      probeSeq: expect.any(Number),
    });
  });

  it("retries a queued recovery acknowledgement after its transport send throws", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000, 50);
    pair.a.disconnect();
    pair.a.attachTransport(throwNextKind(
      pair.bus.connect("runtime-a-throwing-recovery-ack"),
      "ACK",
    ));

    expect(() => pair.b.setHidden(true)).toThrow("injected ACK send failure");
    expect(pair.a.view().phase).toBe("network-pause");
    expect(pair.b.view().phase).toBe("network-pause");

    advanceBoth(pair, 250, 50);
    pair.b.setHidden(false);
    stabilizeRecovery(pair);

    expect(pair.a.view().phase).toBe("countdown");
    expect(pair.b.view().phase).toBe("countdown");
  });

  it("does not report a rejected delivery probe as sent", () => {
    const diagnostics = new NetworkDiagnostics();
    const pair = createPair({ aDiagnostics: diagnostics });

    pair.a.disconnect("startup-failure");
    expect(() => pair.a.attachTransport(throwNextKind(
      pair.bus.connect("runtime-a-throwing-delivery-probe"),
      "KEEPALIVE",
    ))).toThrow("injected KEEPALIVE send failure");
    pair.a.disconnect("startup-failure");

    const events = diagnostics.snapshot().incidents.flatMap(
      (incident) => incident.events,
    );
    const detached = events[events.length - 1];
    expect(detached).toMatchObject({
      kind: "channel-detached",
      telemetry: {
        sendChannel: {
          frames: 0,
          keepalives: 0,
          failed: { frames: 1 },
        },
        outboundProof: {
          deliveryProbe: {
            sent: 0,
            echoed: 0,
          },
        },
      },
    });
  });

  it("does not accept an echo for a delivery probe rejected by transport", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    pair.b.setHidden(true);

    pair.a.disconnect("replacement");
    const replacementId = "runtime-a-rejected-probe-echo";
    const heldReplacementInbound = pair.bus.holdMatching(
      "runtime-b",
      replacementId,
      () => true,
    );
    const endpoint = pair.bus.connect(replacementId);
    let currentListener: ((data: Uint8Array) => void) | null = null;
    let rejectedProbeSeq: number | null = null;
    let rejectProbe = true;
    pair.a.attachTransport({
      setListener: (listener) => {
        currentListener = listener;
        endpoint.setListener(listener);
      },
      send: (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (
          rejectProbe &&
          decoded.ok &&
          decoded.value.kind === "KEEPALIVE" &&
          decoded.value.payload.probeSeq !== undefined
        ) {
          rejectProbe = false;
          rejectedProbeSeq = decoded.value.payload.probeSeq;
          throw new Error("injected delivery probe rejection");
        }
        endpoint.send(data);
      },
      leave: () => endpoint.leave(),
    });
    expect(() => pair.a.pump()).toThrow("injected delivery probe rejection");
    expect(rejectedProbeSeq).not.toBeNull();

    let resumePings = 0;
    const observePings = pair.bus.holdMatching(
      replacementId,
      "runtime-b",
      (data) => {
        const decoded = decodeEnvelope(data, { expectedMatchId: "match-1" });
        if (decoded.ok && decoded.value.kind === "CLOCK_PING") {
          resumePings += 1;
        }
        return false;
      },
    );
    if (currentListener === null || rejectedProbeSeq === null) {
      throw new Error("Rejected probe setup failed");
    }
    (currentListener as (data: Uint8Array) => void)(encodeEnvelope({
      protocol: 1,
      matchId: "match-1",
      senderId: "player-b",
      sessionId: "session-b",
      kind: "KEEPALIVE",
      matchTick: pair.b.view().matchTick,
      sentAtMonotonicMs: pair.bClock.now(),
      payload: {
        activeSessionId: "session-b",
        resumeAvailable: true,
        lastSnapshotSeq: 0,
        echoProbeSeq: rejectedProbeSeq,
        inboundCritical: [],
      },
    }));

    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      connectionStatus: "unstable",
    });
    expect(resumePings).toBe(0);
    pair.bus.discardHeld(observePings);
    pair.bus.discardHeld(heldReplacementInbound);
  });

  it("warns at three seconds, pauses at five, and replaces only after sustained silence", () => {
    const onRecoveryNeeded = vi.fn<() => void>();
    const persistDiagnostic = vi.fn<(key: string, value: string) => void>();
    const diagnostics = new NetworkDiagnostics({
      storage: {
        getItem: () => null,
        setItem: persistDiagnostic,
      },
    });
    const pair = createPair({
      aDiagnostics: diagnostics,
      onATransportRecoveryNeeded: onRecoveryNeeded,
    });
    ready(pair);
    advanceBoth(pair, 3_000);
    pair.b.disconnect();

    advanceBoth(pair, 2_999, 100);
    expect(pair.a.view()).toMatchObject({
      phase: "playing",
      connectionStatus: "connected",
      recoveryRequired: false,
    });

    advanceBoth(pair, 1, 1);
    expect(pair.a.view()).toMatchObject({
      phase: "playing",
      connectionStatus: "unstable",
      recoveryRequired: false,
    });
    expect(onRecoveryNeeded).not.toHaveBeenCalled();
    expect(persistDiagnostic).not.toHaveBeenCalled();

    advanceBoth(pair, 1_999, 100);
    expect(pair.a.view()).toMatchObject({
      phase: "playing",
      connectionStatus: "unstable",
      recoveryRequired: false,
    });

    advanceBoth(pair, 1, 1);
    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      connectionStatus: "unstable",
      recoveryRequired: false,
    });
    expect(onRecoveryNeeded).not.toHaveBeenCalled();
    expect(persistDiagnostic).toHaveBeenCalledTimes(1);
    expect(diagnostics.snapshot().incidents[0]).toMatchObject({
      context: { matchId: "match-1", localSeat: "a" },
      events: [{
        kind: "connection-unstable",
        pauseTrigger: "local-silence",
        pauseEpoch: 1,
      }],
    });

    advanceBoth(pair, 2_999, 100);
    expect(onRecoveryNeeded).not.toHaveBeenCalled();
    expect(persistDiagnostic).toHaveBeenCalledTimes(1);
    advanceBoth(pair, 1, 1);
    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      connectionStatus: "reconnecting",
      recoveryRequired: true,
    });
    expect(onRecoveryNeeded).toHaveBeenCalledTimes(1);
    expect(persistDiagnostic).toHaveBeenCalledTimes(2);
  });

  it("records visibility pauses and ordinary channel teardown distinctly", () => {
    const diagnostics = new NetworkDiagnostics({ clock: new ManualClock(30_000) });
    const pair = createPair({ aDiagnostics: diagnostics });
    pair.a.start();
    pair.b.start();

    pair.a.setHidden(true);
    pair.a.disconnect("session-teardown");

    expect(diagnostics.snapshot().incidents[0]).toMatchObject({
      context: { matchId: "match-1", localSeat: "a" },
      events: [
        {
          kind: "connection-unstable",
          pauseTrigger: "visibility",
          pauseEpoch: 1,
        },
        { kind: "channel-detached", detachReason: "session-teardown" },
      ],
    });
  });

  it("retains a standalone startup-failure detach diagnostic", () => {
    const diagnostics = new NetworkDiagnostics({ clock: new ManualClock(31_000) });
    const pair = createPair({ aDiagnostics: diagnostics });
    pair.a.start();

    pair.a.disconnect("startup-failure");

    expect(diagnostics.snapshot().incidents[0]).toMatchObject({
      context: { matchId: "match-1", localSeat: "a" },
      events: [{
        kind: "channel-detached",
        detachReason: "startup-failure",
        telemetry: expect.any(Object),
      }],
    });
  });

  it("contains failed replacement callbacks and backs retries off", () => {
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

    expect(() => advanceBoth(pair, 2_999, 100)).not.toThrow();
    expect(onRecoveryNeeded).toHaveBeenCalledTimes(1);
    expect(() => advanceBoth(pair, 1, 1)).not.toThrow();
    expect(onRecoveryNeeded).toHaveBeenCalledTimes(2);

    expect(() => advanceBoth(pair, 5_999, 100)).not.toThrow();
    expect(onRecoveryNeeded).toHaveBeenCalledTimes(2);
    expect(() => advanceBoth(pair, 1, 1)).not.toThrow();
    expect(onRecoveryNeeded).toHaveBeenCalledTimes(3);
    expect(
      diagnostics
        .snapshot()
        .incidents[0]?.events.filter(
          (event) => event.kind === "channel-replacement-failed",
        )
        .map((event) => event.attempt),
    ).toEqual([1, 2, 3]);
  });

  it("staggers Seat B's first replacement to avoid symmetric channel churn", () => {
    const onRecoveryNeeded = vi.fn<() => false>(() => false);
    const pair = createPair({ onBTransportRecoveryNeeded: onRecoveryNeeded });
    ready(pair);
    advanceBoth(pair, 3_000);
    pair.a.disconnect();

    advanceBoth(pair, 8_000, 100);
    expect(onRecoveryNeeded).not.toHaveBeenCalled();

    advanceBoth(pair, 500, 100);
    expect(onRecoveryNeeded).toHaveBeenCalledTimes(1);
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
    advanceBoth(pair, 3_000, 50);

    const events = diagnostics.snapshot().incidents[0]?.events ?? [];
    expect(events.map((event) => event.kind)).toEqual([
      "connection-unstable",
      "channel-replacement-requested",
      "peer-traffic-restored",
      "resume-state-sent",
      "resume-countdown",
      "resumed",
    ]);
    expect(
      events
        .filter((event) => event.telemetry !== undefined)
        .map((event) => event.kind),
    ).toEqual([
      "connection-unstable",
      "channel-replacement-requested",
      "peer-traffic-restored",
    ]);
    expect(events[0]?.telemetry?.sinceAuthenticated.sentSnapshots).toBeGreaterThan(
      0,
    );
    expect(events[4]?.rollback).toMatchObject({
      originalPauseTick: events[0]?.pauseTick,
      localResumeTick: expect.any(Number),
      remoteResumeTick: expect.any(Number),
      finalCommonTick: events[4]?.pauseTick,
    });
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

  it("ends neutrally once after twenty seconds of visible peer silence", () => {
    const onForfeitWin = vi.fn();
    const onAResult = vi.fn<(result: MatchResult) => void>();
    const pair = createPair({
      onAForfeitWin: onForfeitWin,
      onAResultConfirmed: onAResult,
    });
    ready(pair);
    advanceBoth(pair, 3_000);
    pair.b.disconnect();

    advanceBoth(pair, RULES.network.missingPeerMs);
    pair.aClock.advance(
      20_000 - RULES.network.missingPeerMs - 1,
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

  it("ends when a peer stays hidden but keeps sending realtime heartbeats", () => {
    const onAResult = vi.fn<(result: MatchResult) => void>();
    const pair = createPair({ onAResultConfirmed: onAResult });
    ready(pair);
    advanceBoth(pair, 3_000);

    pair.b.setHidden(true);
    advanceBoth(
      pair,
      RULES.network.controllerReconnectGraceMs - 1,
      1_000,
    );
    expect(onAResult).not.toHaveBeenCalled();

    advanceBoth(pair, 1, 1);
    expect(onAResult).toHaveBeenCalledTimes(1);
    expect(pair.a.view()).toMatchObject({
      phase: "finished",
      terminal: { outcome: "desync", reason: "connection-lost" },
    });
  });

  it("reports the remaining committed-controller reconnect grace", () => {
    const pair = createPair();
    ready(pair);
    advanceBoth(pair, 3_000);
    expect(pair.a.view().reconnectRemainingSeconds).toBeUndefined();

    pair.b.disconnect();
    advanceBoth(pair, RULES.network.missingPeerMs);
    expect(pair.a.view()).toMatchObject({
      phase: "network-pause",
      reconnectRemainingSeconds: 15,
    });

    pair.aClock.advance(14_000);
    pair.a.pump();
    expect(pair.a.view().reconnectRemainingSeconds).toBe(1);
  });

  it("gives a later peer-silence incident a fresh grace after verified recovery", () => {
    const onAResult = vi.fn<(result: MatchResult) => void>();
    const pair = createPair({ onAResultConfirmed: onAResult });
    ready(pair);
    advanceBoth(pair, 3_600, 100);
    pair.b.disconnect();
    advanceBoth(
      pair,
      RULES.network.controllerReconnectGraceMs -
        RULES.network.missingPeerMs -
        1,
      1_000,
    );
    expect(onAResult).not.toHaveBeenCalled();

    pair.b.attachTransport(pair.bus.connect("runtime-b-between-incidents"));
    stabilizeRecovery(pair);
    advanceBoth(
      pair,
      (RULES.network.fastResumeCountdownTicks * 1_000) /
        RULES.timing.ticksPerSecond,
      50,
    );
    expect(pair.a.view().phase).toBe("playing");
    expect(pair.b.view().phase).toBe("playing");

    pair.b.disconnect();
    advanceBoth(
      pair,
      RULES.network.controllerReconnectGraceMs -
        RULES.network.keepaliveMs -
        1,
      1_000,
    );
    expect(onAResult).not.toHaveBeenCalled();

    advanceBoth(pair, RULES.network.keepaliveMs + 1, 1);
    expect(onAResult).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh peer-silence grace period after returning visible", () => {
    const onAResult = vi.fn<(result: MatchResult) => void>();
    const pair = createPair({ onAResultConfirmed: onAResult });
    ready(pair);
    advanceBoth(pair, 3_000);
    pair.b.disconnect();
    advanceBoth(pair, RULES.network.missingPeerMs);

    pair.a.setHidden(true);
    advanceBoth(pair, RULES.network.controllerReconnectGraceMs + 5_000, 1_000);

    expect(pair.a.view().phase).toBe("network-pause");
    expect(onAResult).not.toHaveBeenCalled();

    pair.a.setHidden(false);
    pair.a.pump();
    pair.aClock.advance(RULES.network.controllerReconnectGraceMs - 1);
    pair.a.pump();
    expect(onAResult).not.toHaveBeenCalled();

    pair.aClock.advance(1);
    pair.a.pump();
    expect(onAResult).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh grace when returning before a still-hidden peer", () => {
    const onAResult = vi.fn<(result: MatchResult) => void>();
    const pair = createPair({ onAResultConfirmed: onAResult });
    ready(pair);
    advanceBoth(pair, 3_000);

    pair.a.setHidden(true);
    pair.b.setHidden(true);
    advanceBoth(pair, RULES.network.controllerReconnectGraceMs + 5_000, 1_000);
    expect(onAResult).not.toHaveBeenCalled();

    pair.a.setHidden(false);
    advanceBoth(
      pair,
      RULES.network.controllerReconnectGraceMs - 1,
      1_000,
    );
    expect(onAResult).not.toHaveBeenCalled();

    advanceBoth(pair, 1, 1);
    expect(onAResult).toHaveBeenCalledTimes(1);
  });

  it("keeps the visible peer-loss deadline across repeated visible notifications", () => {
    const onAResult = vi.fn<(result: MatchResult) => void>();
    const pair = createPair({ onAResultConfirmed: onAResult });
    ready(pair);
    advanceBoth(pair, 3_000);
    pair.b.disconnect();
    advanceBoth(pair, RULES.network.missingPeerMs);

    for (let notification = 0; notification < 3; notification += 1) {
      advanceBoth(pair, 4_000, 1_000);
      pair.a.setHidden(false);
    }

    expect(pair.a.view().reconnectRemainingSeconds).toBe(3);
    expect(onAResult).not.toHaveBeenCalled();

    advanceBoth(pair, 2_999, 1_000);
    expect(onAResult).not.toHaveBeenCalled();

    advanceBoth(pair, 1, 1);
    expect(onAResult).toHaveBeenCalledTimes(1);
  });

  it("preserves one visible peer-loss deadline across transport replacements", () => {
    const onAResult = vi.fn<(result: MatchResult) => void>();
    const pair = createPair({ onAResultConfirmed: onAResult });
    ready(pair);
    advanceBoth(pair, 3_000);
    pair.b.disconnect();
    advanceBoth(pair, RULES.network.missingPeerMs);

    for (let replacement = 1; replacement <= 3; replacement += 1) {
      advanceBoth(pair, 4_000, 1_000);
      pair.a.disconnect();
      pair.a.attachTransport(
        pair.bus.connect(`runtime-a-replacement-${replacement}`),
      );
    }

    expect(pair.a.view().reconnectRemainingSeconds).toBe(3);
    expect(onAResult).not.toHaveBeenCalled();

    advanceBoth(pair, 2_999, 1_000);
    expect(onAResult).not.toHaveBeenCalled();

    advanceBoth(pair, 1, 1);
    expect(onAResult).toHaveBeenCalledTimes(1);
  });

  it("lets only the connected visible controller record a neutral loss", () => {
    const onAResult = vi.fn<(result: MatchResult) => void>();
    const onBResult = vi.fn<(result: MatchResult) => void>();
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
      RULES.network.controllerReconnectGraceMs - RULES.network.missingPeerMs,
    );
    pair.b.pump();

    expect(onAResult).not.toHaveBeenCalled();
    expect(onBResult).toHaveBeenCalledTimes(1);
    expect(onBResult).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "desync",
        reason: "connection-lost",
        completedBy: "player-a",
      }),
    );
    expect(pair.a.view().result).toBeUndefined();
    expect(pair.b.view().result).toBeDefined();
  });

  it("retries a dropped explicit forfeit before reporting canonical delivery", () => {
    const onAResult = vi.fn<(result: MatchResult) => void>();
    const onBResult = vi.fn<(result: MatchResult) => void>();
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

    pair.bClock.advance(CRITICAL_INITIAL_RETRANSMIT_MS - 1);
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
    const onAResult = vi.fn<(result: MatchResult) => void>();
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
    const onAResult = vi.fn<(result: MatchResult) => void>();
    const onBResult = vi.fn<(result: MatchResult) => void>();
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
