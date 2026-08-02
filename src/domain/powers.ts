import { RULES } from "../config/rules";
import type { Cell, Grid, PowerKind, StatusState } from "./types";

function cloneGrid(grid: Grid): Grid {
  return grid.map((row) => row.map((cell) => (cell === null ? null : { ...cell })));
}

export function tickStatuses(statuses: readonly StatusState[], ticks = 1): StatusState[] {
  const elapsed = Math.max(0, Math.floor(ticks));
  const active: StatusState[] = [];
  for (const status of statuses) {
    const remainingTicks = Math.max(0, status.remainingTicks - elapsed);
    if (remainingTicks === 0) continue;
    if (status.kind === "barrier") {
      active.push({ kind: "barrier", remainingTicks, capacity: status.capacity });
    } else {
      active.push({ kind: status.kind, remainingTicks });
    }
  }
  return active;
}

export function activateTimedStatus(
  statuses: readonly StatusState[],
  kind: "blackout" | "scramble",
): StatusState[] {
  const remainingTicks =
    kind === "blackout" ? RULES.power.blackoutTicks : RULES.power.scrambleTicks;
  return [
    ...statuses.filter((status) => status.kind !== kind),
    { kind, remainingTicks },
  ];
}

export function activateBarrier(statuses: readonly StatusState[]): StatusState[] {
  return [
    ...statuses.filter((status) => status.kind !== "barrier"),
    {
      kind: "barrier",
      remainingTicks: RULES.garbage.barrierTicks,
      capacity: RULES.garbage.barrierCapacity,
    },
  ];
}

export interface NukeResult {
  grid: Grid;
  target: { x: number; y: number } | null;
  removed: number;
}

export function applyNuke(source: Grid): NukeResult {
  const grid = cloneGrid(source);
  const rowIndex = grid.findIndex((row) => row.some((cell) => cell !== null));
  if (rowIndex < 0) return { grid, target: null, removed: 0 };

  const occupiedColumns = grid[rowIndex]!
    .map((cell, column) => ({ cell, column }))
    .filter(({ cell }) => cell !== null)
    .map(({ column }) => column)
    .sort((left, right) => {
      const distance = Math.abs(left - (RULES.board.width - 1) / 2) -
        Math.abs(right - (RULES.board.width - 1) / 2);
      return distance === 0 ? left - right : distance;
    });
  const column = occupiedColumns[0] as number;
  let removed = 0;
  for (let row = Math.max(0, rowIndex - RULES.power.nukeRadius); row <= Math.min(
    RULES.board.height - 1,
    rowIndex + RULES.power.nukeRadius,
  ); row += 1) {
    for (let x = Math.max(0, column - RULES.power.nukeRadius); x <= Math.min(
      RULES.board.width - 1,
      column + RULES.power.nukeRadius,
    ); x += 1) {
      if (grid[row]![x] !== null) {
        grid[row]![x] = null;
        removed += 1;
      }
    }
  }
  return { grid, target: { x: column, y: rowIndex }, removed };
}

function compact(grid: Grid): void {
  for (let column = 0; column < RULES.board.width; column += 1) {
    const cells: Cell[] = [];
    for (let row = RULES.board.height - 1; row >= 0; row -= 1) {
      const cell = grid[row]![column];
      if (cell !== null && cell !== undefined) cells.push(cell);
      grid[row]![column] = null;
    }
    cells.forEach((cell, offset) => {
      grid[RULES.board.height - 1 - offset]![column] = cell;
    });
  }
}

function collapseBaseScore(lines: number): number {
  let remaining = lines;
  let score = 0;
  while (remaining >= 4) {
    score += RULES.scoring.tetris;
    remaining -= 4;
  }
  if (remaining === 1) score += RULES.scoring.single;
  else if (remaining === 2) score += RULES.scoring.double;
  else if (remaining === 3) score += RULES.scoring.triple;
  return score;
}

export interface CollapseResult {
  grid: Grid;
  clearedLines: number;
  score: number;
  triggeredSpecials: 0;
}

export function applyCollapse(source: Grid, level: number): CollapseResult {
  const grid = cloneGrid(source);
  compact(grid);
  const complete = grid
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.every((cell) => cell !== null))
    .map(({ index }) => index);
  for (const row of [...complete].sort((left, right) => right - left)) {
    grid.splice(row, 1);
  }
  for (let row = 0; row < complete.length; row += 1) {
    grid.unshift(Array.from({ length: RULES.board.width }, () => null));
  }
  return {
    grid,
    clearedLines: complete.length,
    score: collapseBaseScore(complete.length) * Math.max(1, Math.floor(level)),
    triggeredSpecials: 0,
  };
}

export function queueReplacementPower(
  pending: readonly ("monomino-rush" | "acid-rain")[],
  power: PowerKind,
): Array<"monomino-rush" | "acid-rain"> {
  if (power !== "monomino-rush" && power !== "acid-rain") return [...pending];
  if (pending.length >= RULES.power.replacementQueueCap) return [...pending];
  return [...pending, power];
}

export function dissolveColumn(source: Grid, column: number): { grid: Grid; removed: number } {
  const grid = cloneGrid(source);
  if (!Number.isInteger(column) || column < 0 || column >= RULES.board.width) {
    return { grid, removed: 0 };
  }
  let removed = 0;
  for (const row of grid) {
    if (row[column] !== null) {
      row[column] = null;
      removed += 1;
    }
  }
  return { grid, removed };
}
