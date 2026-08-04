import { describe, expect, it } from "vitest";
import { createBoard } from "../../src/domain/board";
import {
  activateBarrier,
  activateTimedStatus,
  applyCollapse,
  applyNuke,
  queueReplacementPower,
  tickStatuses,
} from "../../src/domain/powers";
import type { StatusState } from "../../src/domain/types";

describe("automatic powers", () => {
  it("resets Blackout and Scramble durations instead of stacking", () => {
    let statuses: StatusState[] = [];
    statuses = activateTimedStatus(statuses, "blackout");
    statuses = tickStatuses(statuses, 400);
    statuses = activateTimedStatus(statuses, "blackout");
    statuses = activateTimedStatus(statuses, "scramble");

    expect(statuses).toContainEqual({ kind: "blackout", remainingTicks: 900 });
    expect(statuses).toContainEqual({ kind: "scramble", remainingTicks: 600 });
    expect(statuses).toHaveLength(2);
  });

  it("resets Barrier to 1,200 ticks and four rows", () => {
    const status = activateBarrier([
      { kind: "barrier", remainingTicks: 2, capacity: 1 },
    ]);

    expect(status).toEqual([{ kind: "barrier", remainingTicks: 1_200, capacity: 4 }]);
  });

  it("Nuke chooses the densest 5x5 blast on the highest occupied row", () => {
    const grid = createBoard();
    grid[3]![1] = { kind: "T" };
    grid[3]![8] = { kind: "T" };
    grid[4]![0] = { kind: "I", special: "glitch-core" };
    grid[4]![2] = { kind: "J" };
    grid[5]![3] = { kind: "L" };
    grid[4]![8] = { kind: "S" };
    grid[8]![9] = { kind: "O" };

    const result = applyNuke(grid);

    expect(result.target).toEqual({ x: 2, y: 3 });
    expect(result.cells).toEqual([
      { x: 1, y: 3 },
      { x: 0, y: 4 },
      { x: 2, y: 4 },
      { x: 3, y: 5 },
    ]);
    expect(result.removed).toBe(4);
    expect(result.grid[3]![1]).toBeNull();
    expect(result.grid[4]![0]).toBeNull();
    expect(result.grid[3]![8]).toEqual({ kind: "T" });
    expect(result.grid[8]![9]).toEqual({ kind: "O" });
    expect(applyNuke(createBoard())).toMatchObject({ target: null, cells: [] });
  });

  it("Nuke considers empty centers that still cover the highest occupied row", () => {
    const grid = createBoard();
    grid[0]![0] = { kind: "T" };
    grid[0]![9] = { kind: "T" };
    grid[1]![0] = { kind: "I" };
    grid[2]![2] = { kind: "O" };
    grid[1]![3] = { kind: "J" };
    grid[2]![4] = { kind: "L" };

    const result = applyNuke(grid);

    expect(result.target).toEqual({ x: 2, y: 0 });
    expect(result.cells).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 3, y: 1 },
      { x: 2, y: 2 },
      { x: 4, y: 2 },
    ]);
  });

  it("Collapse compacts columns, preserves markers while moving, then scores clears only", () => {
    const grid = createBoard();
    for (let column = 0; column < 10; column += 1) {
      grid[18]![column] = { kind: "J" };
      grid[20]![column] =
        column === 4 ? { kind: "T", special: "column-bomb" } : { kind: "T" };
    }

    const result = applyCollapse(grid, 2);

    expect(result.clearedLines).toBe(2);
    expect(result.score).toBe(600);
    expect(result.grid.every((row) => row.every((cell) => cell === null))).toBe(true);
    expect(result.triggeredSpecials).toBe(0);
  });

  it("queues replacement powers FIFO without interrupting an active mode", () => {
    expect(queueReplacementPower(["acid-rain"], "monomino-rush")).toEqual([
      "acid-rain",
      "monomino-rush",
    ]);
    expect(queueReplacementPower([], "blackout")).toEqual([]);
  });

  it("bounds the replacement-mode FIFO at two pending powers", () => {
    expect(
      queueReplacementPower(["acid-rain", "monomino-rush"], "acid-rain"),
    ).toEqual(["acid-rain", "monomino-rush"]);
  });
});
