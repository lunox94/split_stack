import { RULES, STANDARD_SHAPES } from "../config/rules";
import { deriveEventUint32 } from "./rng";
import type { Grid, PieceDescriptor, SpecialKind } from "./types";

export interface ForcedQueueResult {
  queue: PieceDescriptor[];
  overflowGarbageRows: number;
}

export function enqueueHollowCross(
  forcedQueue: readonly PieceDescriptor[],
  eventId: string,
): ForcedQueueResult {
  const pending = forcedQueue.filter((piece) => piece.source === "cross").length;
  if (pending >= RULES.hollowCross.queueCap) {
    return {
      queue: [...forcedQueue],
      overflowGarbageRows: RULES.hollowCross.overflowGarbageRows,
    };
  }
  return {
    queue: [...forcedQueue, { source: "cross", shape: "cross", eventId }],
    overflowGarbageRows: 0,
  };
}

export function createGlitchDescriptor(seed: string, eventId: string): PieceDescriptor {
  const shape =
    STANDARD_SHAPES[
      deriveEventUint32(seed, eventId, "glitch-shape") % STANDARD_SHAPES.length
    ] ?? "I";
  return { source: "glitch", shape, eventId };
}

export function enqueueGlitch(
  forcedQueue: readonly PieceDescriptor[],
  seed: string,
  eventId: string,
): ForcedQueueResult {
  const pending = forcedQueue.filter((piece) => piece.source === "glitch").length;
  if (pending >= RULES.special.glitchQueueCap) {
    return { queue: [...forcedQueue], overflowGarbageRows: 1 };
  }
  const queue = [...forcedQueue];
  let insertionIndex = 0;
  while (queue[insertionIndex]?.source === "glitch") insertionIndex += 1;
  queue.splice(insertionIndex, 0, createGlitchDescriptor(seed, eventId));
  return { queue, overflowGarbageRows: 0 };
}

export interface CapturedSpecial {
  kind: SpecialKind;
  row: number;
  column: number;
}

export function captureSpecialTriggers(
  grid: Grid,
  completedRows: readonly number[],
): CapturedSpecial[] {
  const rows = new Set(completedRows);
  const captured: CapturedSpecial[] = [];
  grid.forEach((row, rowIndex) => {
    if (!rows.has(rowIndex)) return;
    row.forEach((cell, column) => {
      if (cell?.special !== undefined) {
        captured.push({ kind: cell.special, row: rowIndex, column });
      }
    });
  });
  return captured.sort((left, right) => right.row - left.row || left.column - right.column);
}

export interface SpecialResolution {
  grid: Grid;
  garbageCoreEvents: string[];
  glitchEvents: string[];
  destroyedCells: number;
}

export function resolveSpecialTriggers(
  source: Grid,
  captured: readonly CapturedSpecial[],
  _seed: string,
  lockEventId: string,
): SpecialResolution {
  const grid = source.map((row) =>
    row.map((cell) => (cell === null ? null : { ...cell })),
  );
  const garbageCoreEvents: string[] = [];
  const glitchEvents: string[] = [];
  let garbageOrdinal = 0;
  let glitchOrdinal = 0;
  let destroyedCells = 0;

  const ordered = [...captured].sort(
    (left, right) => right.row - left.row || left.column - right.column,
  );
  for (const trigger of ordered) {
    if (trigger.kind === "column-bomb") {
      for (const row of grid) {
        if (row[trigger.column] !== null) {
          row[trigger.column] = null;
          destroyedCells += 1;
        }
      }
    } else if (trigger.kind === "garbage-core") {
      garbageOrdinal += 1;
      garbageCoreEvents.push(`${lockEventId}:garbage-core:${garbageOrdinal}`);
    } else {
      glitchOrdinal += 1;
      glitchEvents.push(`${lockEventId}:glitch-core:${glitchOrdinal}`);
    }
  }
  return { grid, garbageCoreEvents, glitchEvents, destroyedCells };
}
