import { describe, expect, it } from "vitest";

import {
  RemoteSnapshotStore,
  SnapshotScheduler,
  createPlayerSnapshot,
  decodeGrid,
  encodeGrid,
  type PlayerSnapshotV1,
} from "../../src/network/snapshots";
import type { RealtimeEnvelope } from "../../src/network/messages";
import type { Grid, PlayerGameState } from "../../src/domain/types";

function snapshot(sequence: number, tick: number): PlayerSnapshotV1 {
  return {
    schema: "split-stack/snapshot/v1",
    snapshotSeq: sequence,
    stateTick: tick,
    playerId: "player-a",
    grid: new Array<number>(220).fill(0),
    active: null,
    ghostRow: null,
    hold: null,
    nextFive: [],
    basePieceCursor: 0,
    forcedQueue: [],
    score: 0,
    level: 1,
    lines: 0,
    comboIndex: -1,
    backToBack: false,
    powerCharge: 0,
    powerDeckCursor: 0,
    upcomingPower: "blackout",
    statuses: [],
    incomingGarbage: [],
    holdUsed: false,
    pendingReplacementModes: [],
    replacementMode: null,
    lastGarbageHole: null,
    specialSchedule: { standardCursor: 0, ordinalCycle: 0, typeCursor: 0 },
    stats: {
      garbageSent: 0,
      powersActivated: 0,
      tetrises: 0,
      tSpinSingles: 0,
      tSpinDoubles: 0,
      tSpinTriples: 0,
    },
    topOut: null,
    lastAppliedCritical: [],
    stateHash: 0,
  };
}

function envelope(
  sequence: number,
  tick: number,
  sessionId = "session-a",
): RealtimeEnvelope<"SNAPSHOT"> {
  return {
    protocol: 1,
    matchId: "match-1",
    senderId: "player-a",
    sessionId,
    kind: "SNAPSHOT",
    matchTick: tick,
    sentAtMonotonicMs: tick * 20,
    payload: snapshot(sequence, tick),
  };
}

describe("snapshot scheduling", () => {
  it("publishes once at tick zero and every six active simulation ticks", () => {
    const scheduler = new SnapshotScheduler(6);

    expect(scheduler.claim(0, true)).toBe(true);
    expect(scheduler.claim(0, true)).toBe(false);
    expect(scheduler.claim(5, true)).toBe(false);
    expect(scheduler.claim(6, true)).toBe(true);
    expect(scheduler.claim(12, false)).toBe(false);
    expect(scheduler.claim(12, true)).toBe(true);
  });
});

describe("remote snapshot replacement", () => {
  it("keeps only the newest snapshot from the explicitly bound runtime session", () => {
    const store = new RemoteSnapshotStore();
    store.bind("player-a", "session-a");

    expect(store.accept(envelope(2, 12))).toBe(true);
    store.bind("player-a", "session-a");
    expect(store.accept(envelope(1, 6))).toBe(false);
    expect(store.accept(envelope(3, 18, "superseded-session"))).toBe(false);
    expect(store.latest("player-a")?.snapshotSeq).toBe(2);
  });

  it("does not expose mutable aliases to the accepted remote snapshot", () => {
    const store = new RemoteSnapshotStore();
    store.bind("player-a", "session-a");
    const incoming = envelope(1, 6);
    expect(store.accept(incoming)).toBe(true);

    incoming.payload.grid[0] = 1;
    const firstRead = store.latest("player-a")!;
    firstRead.grid[0] = 2;

    expect(store.latest("player-a")?.grid[0]).toBe(0);
  });

  it("rejects malformed compact grids", () => {
    const store = new RemoteSnapshotStore();
    store.bind("player-a", "session-a");
    const malformed = envelope(1, 6);
    malformed.payload.grid.pop();

    expect(store.accept(malformed)).toBe(false);
  });

  it("rejects malformed nested piece descriptors", () => {
    const store = new RemoteSnapshotStore();
    store.bind("player-a", "session-a");
    const malformed = envelope(1, 6);
    malformed.payload.nextFive = [
      { source: "base", shape: "not-a-shape" } as never,
    ];

    expect(store.accept(malformed)).toBe(false);
  });

  it("requires an embedded special marker index and kind as a pair", () => {
    const store = new RemoteSnapshotStore();
    store.bind("player-a", "session-a");
    const malformed = envelope(1, 6);
    malformed.payload.nextFive = [
      { source: "base", shape: "T", specialCellIndex: 2 },
    ];

    expect(store.accept(malformed)).toBe(false);
  });

  it("accepts only the canonical bounded Glitch preview cosmetic metadata", () => {
    const store = new RemoteSnapshotStore();
    store.bind("player-a", "session-a");
    const valid = envelope(1, 6);
    valid.payload.nextFive = [{
      source: "glitch",
      shape: "I",
      previewCosmetics: {
        kind: "glitch-cycle",
        shapes: ["I", "J", "L", "O", "S", "T", "Z"],
        intervalMs: 150,
        finalShapeConcealed: true,
      },
    }];
    expect(store.accept(valid)).toBe(true);

    const malformed = envelope(2, 12);
    malformed.payload.nextFive = [{
      source: "glitch",
      shape: "I",
      previewCosmetics: {
        kind: "glitch-cycle",
        shapes: ["I", "I", "I", "I", "I", "I", "I"],
        intervalMs: 1,
        finalShapeConcealed: true,
      },
    } as never];
    expect(store.accept(malformed)).toBe(false);
  });
});

describe("compact snapshot grids", () => {
  it("round-trips cell kind and embedded-special identity", () => {
    const grid: Grid = Array.from({ length: 22 }, () =>
      new Array(10).fill(null) as Grid[number],
    );
    grid[21]![0] = { kind: "garbage" };
    grid[20]![4] = { kind: "T", special: "glitch-core" };

    const encoded = encodeGrid(grid);

    expect(encoded).toHaveLength(220);
    expect(decodeGrid(encoded)[20]![4]).toEqual({
      kind: "T",
      special: "glitch-core",
    });
    expect(decodeGrid(encoded)[21]![0]).toEqual({ kind: "garbage" });
  });

  it("builds an immutable wire snapshot from authoritative player state", () => {
    const grid: Grid = Array.from({ length: 22 }, () =>
      new Array(10).fill(null) as Grid[number],
    );
    grid[21]![0] = { kind: "I" };
    const player: PlayerGameState = {
      playerId: "player-a",
      grid,
      active: null,
      hold: null,
      holdUsed: false,
      basePieceCursor: 4,
      forcedQueue: [],
      pendingReplacementModes: [],
      replacementMode: null,
      score: 100,
      lines: 1,
      comboIndex: 0,
      backToBack: false,
      powerCharge: 1,
      powerDeckCursor: 0,
      upcomingPower: "blackout",
      statuses: [],
      incomingGarbage: [],
      lastGarbageHole: null,
      specialSchedule: { standardCursor: 4, ordinalCycle: 0, typeCursor: 0 },
      stats: {
        garbageSent: 0,
        powersActivated: 0,
        tetrises: 0,
        tSpinSingles: 0,
        tSpinDoubles: 0,
        tSpinTriples: 0,
      },
      topOut: null,
    };

    const built = createPlayerSnapshot({
      player,
      stateTick: 60,
      snapshotSeq: 10,
      level: 1,
      ghostRow: null,
      nextFive: [],
      lastAppliedCritical: [],
      stateHash: 123,
    });
    player.grid[21]![0] = null;

    expect(decodeGrid(built.grid)[21]![0]).toEqual({ kind: "I" });
    expect(built).toMatchObject({
      playerId: "player-a",
      basePieceCursor: 4,
      snapshotSeq: 10,
      stateTick: 60,
    });
  });
});
