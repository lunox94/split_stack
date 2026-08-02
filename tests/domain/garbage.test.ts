import { describe, expect, it } from "vitest";
import { createBoard } from "../../src/domain/board";
import {
  applyReadyGarbage,
  cancelIncomingGarbage,
  createGarbagePacket,
} from "../../src/domain/garbage";
import type { GarbagePacket } from "../../src/domain/types";

const SEED = "00112233445566778899aabbccddeeff";

function packet(id: string, rows: number, readyTick: number, hole = 3): GarbagePacket {
  return { id, rows, readyTick, hole };
}

describe("garbage", () => {
  it("cancels oldest ready-time packets before emitting an attack", () => {
    const result = cancelIncomingGarbage(
      [packet("later", 4, 240), packet("first", 2, 200)],
      5,
    );

    expect(result.outgoingRows).toBe(0);
    expect(result.incoming).toEqual([packet("later", 1, 240)]);
  });

  it("uses an event-derived packet hole and forbids consecutive repeats", () => {
    const first = createGarbagePacket(SEED, "attack:1", 3, 250, null);
    const second = createGarbagePacket(SEED, "attack:2", 2, 300, first.hole);

    expect(createGarbagePacket(SEED, "attack:1", 3, 250, null)).toEqual(first);
    expect(second.hole).not.toBe(first.hole);
    expect(first.hole).toBeGreaterThanOrEqual(0);
    expect(first.hole).toBeLessThan(10);
  });

  it("waits through tick 249, then applies no more than four rows at tick 250", () => {
    const grid = createBoard();
    const waiting = applyReadyGarbage(grid, [packet("ready", 6, 250)], 249, null);
    const applied = applyReadyGarbage(grid, [packet("ready", 6, 250)], 250, null);

    expect(waiting.appliedRows).toBe(0);
    expect(applied.appliedRows).toBe(4);
    expect(applied.incoming).toEqual([packet("ready", 2, 250)]);
    expect(applied.grid.slice(18).every((row) => row.filter(Boolean).length === 9)).toBe(true);
  });

  it("lets Barrier consume only attempted rise rows within the four-row boundary", () => {
    const result = applyReadyGarbage(createBoard(), [packet("ready", 6, 0)], 0, {
      kind: "barrier",
      remainingTicks: 40,
      capacity: 2,
    });

    expect(result.blockedRows).toBe(2);
    expect(result.appliedRows).toBe(2);
    expect(result.barrier?.capacity).toBe(0);
    expect(result.incoming).toEqual([packet("ready", 2, 0)]);
  });

  it("top-outs only when a rise would push an occupied row beyond row zero", () => {
    const safeGrid = createBoard();
    safeGrid[1]![4] = { kind: "T" };
    const unsafeGrid = createBoard();
    unsafeGrid[0]![4] = { kind: "T" };

    const safe = applyReadyGarbage(safeGrid, [packet("one", 1, 0)], 0, null);
    const unsafe = applyReadyGarbage(unsafeGrid, [packet("one", 1, 0)], 0, null);

    expect(safe.topOut).toBe(false);
    expect(safe.grid[0]![4]).toEqual({ kind: "T" });
    expect(unsafe.topOut).toBe(true);
  });
});
