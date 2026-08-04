import { RULES } from "../config/rules";
import type { Cell, Coordinate, Grid, PowerKind, StatusState } from "./types";

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
  kind: "blackout" | "scramble" | "ghost-jam",
): StatusState[] {
  const remainingTicks =
    kind === "blackout"
      ? RULES.power.blackoutTicks
      : kind === "ghost-jam"
        ? RULES.power.ghostJamTicks
        : RULES.power.scrambleTicks;
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
  cells: Coordinate[];
  removed: number;
}

export function applyNuke(source: Grid): NukeResult {
  const grid = cloneGrid(source);
  const rowIndex = grid.findIndex((row) => row.some((cell) => cell !== null));
  if (rowIndex < 0) return { grid, target: null, cells: [], removed: 0 };

  const topOccupiedColumns = source[rowIndex]!
    .map((cell, column) => ({ cell, column }))
    .filter(({ cell }) => cell !== null)
    .map(({ column }) => column);
  const candidateColumns = Array.from(
    { length: RULES.board.width },
    (_, column) => column,
  )
    .filter((column) =>
      topOccupiedColumns.some(
        (occupied) => Math.abs(occupied - column) <= RULES.power.nukeRadius,
      ),
    )
    .sort((left, right) => {
      const countCells = (column: number): number => {
        let count = 0;
        for (
          let row = Math.max(0, rowIndex - RULES.power.nukeRadius);
          row <= Math.min(RULES.board.height - 1, rowIndex + RULES.power.nukeRadius);
          row += 1
        ) {
          for (
            let x = Math.max(0, column - RULES.power.nukeRadius);
            x <= Math.min(RULES.board.width - 1, column + RULES.power.nukeRadius);
            x += 1
          ) {
            if (source[row]![x] !== null) count += 1;
          }
        }
        return count;
      };
      const countDifference = countCells(right) - countCells(left);
      if (countDifference !== 0) return countDifference;
      const distance =
        Math.abs(left - (RULES.board.width - 1) / 2) -
        Math.abs(right - (RULES.board.width - 1) / 2);
      return distance === 0 ? left - right : distance;
    });
  const column = candidateColumns[0] as number;
  const cells: Coordinate[] = [];
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
        cells.push({ x, y: row });
      }
    }
  }
  return {
    grid,
    target: { x: column, y: rowIndex },
    cells,
    removed: cells.length,
  };
}

export interface CollapseMovement {
  from: Coordinate;
  to: Coordinate;
}

function compact(grid: Grid): CollapseMovement[] {
  const movements: CollapseMovement[] = [];
  for (let column = 0; column < RULES.board.width; column += 1) {
    const cells: Array<{ cell: Cell; row: number }> = [];
    for (let row = RULES.board.height - 1; row >= 0; row -= 1) {
      const cell = grid[row]![column];
      if (cell !== null && cell !== undefined) cells.push({ cell, row });
      grid[row]![column] = null;
    }
    cells.forEach(({ cell, row }, offset) => {
      const targetRow = RULES.board.height - 1 - offset;
      grid[targetRow]![column] = cell;
      if (targetRow !== row) {
        movements.push({
          from: { x: column, y: row },
          to: { x: column, y: targetRow },
        });
      }
    });
  }
  return movements;
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

export interface PreparedCollapse {
  grid: Grid;
  completedRows: number[];
  movements: CollapseMovement[];
}

export function prepareCollapse(source: Grid): PreparedCollapse {
  const grid = cloneGrid(source);
  const movements = compact(grid);
  const completedRows = grid
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.every((cell) => cell !== null))
    .map(({ index }) => index);
  return { grid, completedRows, movements };
}

export function completePreparedCollapse(
  source: Grid,
  completedRows: readonly number[],
  level: number,
): CollapseResult {
  const grid = cloneGrid(source);
  const ordered = [...completedRows].sort((left, right) => right - left);
  for (const row of ordered) grid.splice(row, 1);
  for (let row = 0; row < completedRows.length; row += 1) {
    grid.unshift(Array.from({ length: RULES.board.width }, () => null));
  }
  return {
    grid,
    clearedLines: completedRows.length,
    score:
      collapseBaseScore(completedRows.length) * Math.max(1, Math.floor(level)),
    triggeredSpecials: 0,
  };
}

export function applyCollapse(source: Grid, level: number): CollapseResult {
  const prepared = prepareCollapse(source);
  return completePreparedCollapse(prepared.grid, prepared.completedRows, level);
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
