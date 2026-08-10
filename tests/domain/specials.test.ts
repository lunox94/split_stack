import { describe, expect, it } from "vitest";
import { createBoard } from "../../src/domain/board";
import {
  captureSpecialTriggers,
  createGlitchDescriptor,
  enqueueGlitch,
  enqueueHollowCross,
  enqueueOversize,
  resolveSpecialTriggers,
} from "../../src/domain/specials";

const SEED = "00112233445566778899aabbccddeeff";

describe("Hollow Cross and embedded special cells", () => {
  it("caps pending Crosses at one and converts overflow into two garbage rows", () => {
    const first = enqueueHollowCross([], "small", "cross:1");
    const overflow = enqueueHollowCross(first.queue, "large", "cross:2");

    expect(first.overflowGarbageRows).toBe(0);
    expect(first.queue).toEqual([
      { source: "cross", shape: "cross", crossVariant: "small", eventId: "cross:1" },
    ]);
    expect(overflow.queue).toEqual(first.queue);
    expect(overflow.overflowGarbageRows).toBe(2);
  });

  it("inserts at most two event-seeded Glitch pieces before other forced pieces", () => {
    const cross = {
      source: "cross", shape: "cross", crossVariant: "large", eventId: "cross",
    } as const;
    const first = enqueueGlitch([cross], SEED, "glitch:1");
    const second = enqueueGlitch(first.queue, SEED, "glitch:2");
    const overflow = enqueueGlitch(second.queue, SEED, "glitch:3");

    expect(first.queue[0]).toEqual({
      source: "glitch",
      shape: "L",
      eventId: "glitch:1",
    });
    expect(second.queue.map((piece) => piece.source)).toEqual(["glitch", "glitch", "cross"]);
    expect(overflow.queue).toEqual(second.queue);
    expect(overflow.overflowGarbageRows).toBe(1);
    expect(createGlitchDescriptor(SEED, "glitch:1")).toEqual(first.queue[0]);
  });

  it("appends one pending Oversize descriptor FIFO and converts overflow to two rows", () => {
    const cross = {
      source: "cross", shape: "cross", crossVariant: "large", eventId: "cross",
    } as const;
    const first = enqueueOversize([cross], "J", "oversize:1");
    const overflow = enqueueOversize(first.queue, "T", "oversize:2");

    expect(first).toEqual({
      queue: [
        cross,
        { source: "oversize", shape: "J", eventId: "oversize:1" },
      ],
      overflowGarbageRows: 0,
    });
    expect(overflow.queue).toEqual(first.queue);
    expect(overflow.overflowGarbageRows).toBe(2);
  });

  it("captures marked cells bottom-first then left-to-right", () => {
    const grid = createBoard();
    grid[20]![7] = { kind: "T", special: "garbage-core" };
    grid[18]![5] = { kind: "I", special: "glitch-core" };
    grid[20]![2] = { kind: "L", special: "column-bomb" };

    expect(captureSpecialTriggers(grid, [18, 20])).toEqual([
      { kind: "column-bomb", row: 20, column: 2 },
      { kind: "garbage-core", row: 20, column: 7 },
      { kind: "glitch-core", row: 18, column: 5 },
    ]);
  });

  it("resolves Column Bomb without cascading or triggering destroyed markers", () => {
    const grid = createBoard();
    grid[10]![2] = { kind: "J", special: "glitch-core" };
    grid[15]![2] = { kind: "T" };
    grid[15]![3] = { kind: "O" };

    const result = resolveSpecialTriggers(
      grid,
      [
        { kind: "column-bomb", row: 20, column: 2 },
        { kind: "garbage-core", row: 20, column: 7 },
        { kind: "glitch-core", row: 18, column: 5 },
      ],
      SEED,
      "lock:9",
    );

    expect(result.grid[10]![2]).toBeNull();
    expect(result.grid[15]![2]).toBeNull();
    expect(result.grid[15]![3]).toEqual({ kind: "O" });
    expect(result.garbageCoreEvents).toEqual(["lock:9:garbage-core:1"]);
    expect(result.glitchEvents).toHaveLength(1);
    expect(result.events).toEqual([
      {
        order: 0,
        kind: "column-bomb",
        row: 20,
        column: 2,
        eventId: "lock:9:column-bomb:1",
        affectedCells: [
          { x: 2, y: 10 },
          { x: 2, y: 15 },
        ],
      },
      {
        order: 1,
        kind: "garbage-core",
        row: 20,
        column: 7,
        eventId: "lock:9:garbage-core:1",
        affectedCells: [],
      },
      {
        order: 2,
        kind: "glitch-core",
        row: 18,
        column: 5,
        eventId: "lock:9:glitch-core:1",
        affectedCells: [],
      },
    ]);
  });

  it("emits deterministic embedded Blackout and Barrier events", () => {
    const result = resolveSpecialTriggers(
      createBoard(),
      [
        { kind: "blackout", row: 20, column: 8 },
        { kind: "barrier", row: 19, column: 1 },
      ],
      SEED,
      "lock:10",
    );

    expect(result.blackoutEvents).toEqual(["lock:10:blackout:1"]);
    expect(result.barrierEvents).toEqual(["lock:10:barrier:1"]);
    expect(result.glitchEvents).toEqual([]);
    expect(result.events).toEqual([
      {
        order: 0,
        kind: "blackout",
        row: 20,
        column: 8,
        eventId: "lock:10:blackout:1",
        affectedCells: [],
      },
      {
        order: 1,
        kind: "barrier",
        row: 19,
        column: 1,
        eventId: "lock:10:barrier:1",
        affectedCells: [],
      },
    ]);
  });
});
