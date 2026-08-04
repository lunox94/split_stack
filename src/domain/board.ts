import { RULES } from "../config/rules";
import { collides } from "./collision";
import { getAbsoluteCells, isStandardShape } from "./pieces";
import type { ActivePiece, CellKind, Grid } from "./types";

export function createBoard(): Grid {
  return Array.from(
    { length: RULES.board.height },
    () => Array.from({ length: RULES.board.width }, () => null),
  );
}

export function cloneBoard(grid: Grid): Grid {
  return grid.map((row) => row.map((cell) => cell === null ? null : { ...cell }));
}

export function findCompleteLines(grid: Grid): number[] {
  const complete: number[] = [];
  for (let row = 0; row < grid.length; row += 1) {
    if (grid[row]?.every((cell) => cell !== null)) complete.push(row);
  }
  return complete;
}

export function clearLines(grid: Grid, rows: readonly number[]): Grid {
  if (rows.some((row) => !Number.isSafeInteger(row) || row < 0 || row >= grid.length)) {
    throw new RangeError("Cleared line index is outside the logical board");
  }
  const removed = new Set(rows);
  const remaining = grid
    .filter((_, row) => !removed.has(row))
    .map((row) => row.map((cell) => cell === null ? null : { ...cell }));
  const emptyRows = Array.from(
    { length: removed.size },
    () => Array.from({ length: RULES.board.width }, () => null),
  );
  return [...emptyRows, ...remaining];
}

export function compactColumns(grid: Grid): Grid {
  const compacted = createBoard();
  for (let column = 0; column < RULES.board.width; column += 1) {
    let targetRow = RULES.board.height - 1;
    for (let sourceRow = grid.length - 1; sourceRow >= 0; sourceRow -= 1) {
      const cell = grid[sourceRow]?.[column] ?? null;
      if (cell !== null) {
        compacted[targetRow]![column] = { ...cell };
        targetRow -= 1;
      }
    }
  }
  return compacted;
}

export function mergePiece(grid: Grid, piece: ActivePiece): Grid {
  if (piece.descriptor.shape === "acid") {
    throw new TypeError("Acid projectiles dissolve instead of merging into the board");
  }
  if (collides(grid, piece)) {
    throw new RangeError("Cannot merge a colliding piece");
  }

  const merged = cloneBoard(grid);
  const kind: CellKind = isStandardShape(piece.descriptor.shape)
    ? piece.descriptor.shape
    : piece.descriptor.shape;
  for (const cell of getAbsoluteCells(piece)) {
    const isMarked =
      piece.descriptor.source === "base" &&
      cell.index === piece.descriptor.specialCellIndex;
    merged[cell.y]![cell.x] = isMarked && piece.descriptor.specialKind !== undefined
      ? { kind, special: piece.descriptor.specialKind }
      : { kind };
  }
  return merged;
}
