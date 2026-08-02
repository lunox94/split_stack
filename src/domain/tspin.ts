import { RULES } from "../config/rules";
import { clearKindFor } from "./scoring";
import type { ActivePiece, ClearKind, Grid } from "./types";

export function isTSpin(grid: Grid, active: ActivePiece): boolean {
  if (active.descriptor.shape !== "T") return false;
  if (
    active.lastSuccessfulAction !== "rotate-cw" &&
    active.lastSuccessfulAction !== "rotate-ccw"
  ) {
    return false;
  }

  const pivotX = active.x + 1;
  const pivotY = active.y + 1;
  const corners = [
    [pivotX - 1, pivotY - 1],
    [pivotX + 1, pivotY - 1],
    [pivotX - 1, pivotY + 1],
    [pivotX + 1, pivotY + 1],
  ] as const;
  const occupied = corners.filter(([x, y]) => {
    if (x < 0 || x >= RULES.board.width || y < 0 || y >= RULES.board.height) {
      return true;
    }
    return grid[y]?.[x] !== null;
  }).length;
  return occupied >= 3;
}

export function classifyTSpin(
  grid: Grid,
  active: ActivePiece,
  completedLineCount: number,
): ClearKind {
  return clearKindFor(completedLineCount, isTSpin(grid, active));
}

