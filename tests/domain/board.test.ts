import { describe, expect, it } from "vitest";
import {
  clearLines,
  cloneBoard,
  compactColumns,
  createBoard,
  findCompleteLines,
  mergePiece,
} from "../../src/domain/board";
import type { ActivePiece } from "../../src/domain/types";

describe("board operations", () => {
  it("creates an empty 22-row by 10-column logical board", () => {
    const grid = createBoard();

    expect(grid).toHaveLength(22);
    expect(grid.every((row) => row.length === 10 && row.every((cell) => cell === null)))
      .toBe(true);
  });

  it("clones rows and occupied cells without retaining mutable aliases", () => {
    const original = createBoard();
    original[21]![4] = { kind: "T", special: "column-bomb" };

    const clone = cloneBoard(original);
    clone[21]![4] = { kind: "I" };

    expect(original[21]![4]).toEqual({ kind: "T", special: "column-bomb" });
    expect(clone[21]).not.toBe(original[21]);
  });

  it("removes complete rows simultaneously and shifts preserved cells downward", () => {
    const grid = createBoard();
    grid[19]![2] = { kind: "L", special: "glitch-core" };
    grid[20] = grid[20]!.map(() => ({ kind: "J" }));
    grid[21] = grid[21]!.map(() => ({ kind: "Z" }));

    const lines = findCompleteLines(grid);
    const cleared = clearLines(grid, lines);

    expect(lines).toEqual([20, 21]);
    expect(cleared).toHaveLength(22);
    expect(cleared[21]![2]).toEqual({ kind: "L", special: "glitch-core" });
    expect(cleared[0]!.every((cell) => cell === null)).toBe(true);
    expect(cleared[1]!.every((cell) => cell === null)).toBe(true);
    expect(grid[20]!.every((cell) => cell?.kind === "J")).toBe(true);
  });

  it("rejects line indices outside the fixed logical board", () => {
    expect(() => clearLines(createBoard(), [-1])).toThrow(RangeError);
    expect(() => clearLines(createBoard(), [22])).toThrow(RangeError);
  });

  it("compacts each column downward without changing vertical order or cell identity", () => {
    const grid = createBoard();
    grid[2]![0] = { kind: "I", special: "garbage-core" };
    grid[10]![0] = { kind: "T" };
    grid[5]![1] = { kind: "J" };
    grid[21]![1] = { kind: "garbage" };

    const compacted = compactColumns(grid);

    expect(compacted[20]![0]).toEqual({ kind: "I", special: "garbage-core" });
    expect(compacted[21]![0]).toEqual({ kind: "T" });
    expect(compacted[20]![1]).toEqual({ kind: "J" });
    expect(compacted[21]![1]).toEqual({ kind: "garbage" });
    expect(compacted.slice(0, 20).every((row) => row[0] === null && row[1] === null)).toBe(true);
    expect(grid[2]![0]).toEqual({ kind: "I", special: "garbage-core" });
  });

  it("merges a rotated piece immutably and keeps its marked mino identity", () => {
    const grid = createBoard();
    const piece: ActivePiece = {
      descriptor: {
        source: "base",
        shape: "T",
        specialCellIndex: 0,
        specialKind: "column-bomb",
      },
      x: 3,
      y: 18,
      rotation: 1,
      lockTicksRemaining: 0,
      lockResetCount: 0,
      lastSuccessfulAction: "hard-drop",
    };

    const merged = mergePiece(grid, piece);

    expect(merged[19]![5]).toEqual({ kind: "T", special: "column-bomb" });
    expect(merged.reduce(
      (count, row) => count + row.filter((cell) => cell?.kind === "T").length,
      0,
    )).toBe(4);
    expect(grid.every((row) => row.every((cell) => cell === null))).toBe(true);
  });
});
