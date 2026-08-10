import { RULES, STANDARD_SHAPES } from "../config/rules";
import { deriveEventUint32 } from "./rng";
import type {
  Coordinate,
  Grid,
  HollowCrossVariant,
  OversizeShape,
  PieceDescriptor,
  SpecialKind,
} from "./types";

export interface ForcedQueueResult {
  queue: PieceDescriptor[];
  overflowGarbageRows: number;
}

export function enqueueHollowCross(
  forcedQueue: readonly PieceDescriptor[],
  crossVariant: HollowCrossVariant,
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
    queue: [...forcedQueue, { source: "cross", shape: "cross", crossVariant, eventId }],
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

export function enqueueOversize(
  forcedQueue: readonly PieceDescriptor[],
  shape: OversizeShape,
  eventId: string,
): ForcedQueueResult {
  const pending = forcedQueue.filter((piece) => piece.source === "oversize").length;
  if (pending >= RULES.power.oversizeQueueCap) {
    return {
      queue: [...forcedQueue],
      overflowGarbageRows: RULES.power.oversizeOverflowGarbageRows,
    };
  }
  return {
    queue: [...forcedQueue, { source: "oversize", shape, eventId }],
    overflowGarbageRows: 0,
  };
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
  blackoutEvents: string[];
  barrierEvents: string[];
  events: SpecialResolutionEvent[];
  destroyedCells: number;
}

export interface SpecialResolutionEvent extends CapturedSpecial {
  order: number;
  eventId: string;
  affectedCells: Coordinate[];
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
  const blackoutEvents: string[] = [];
  const barrierEvents: string[] = [];
  const events: SpecialResolutionEvent[] = [];
  let columnBombOrdinal = 0;
  let garbageOrdinal = 0;
  let glitchOrdinal = 0;
  let blackoutOrdinal = 0;
  let barrierOrdinal = 0;
  let destroyedCells = 0;

  const ordered = [...captured].sort(
    (left, right) => right.row - left.row || left.column - right.column,
  );
  for (const [order, trigger] of ordered.entries()) {
    if (trigger.kind === "column-bomb") {
      columnBombOrdinal += 1;
      const affectedCells: Coordinate[] = [];
      for (const [rowIndex, row] of grid.entries()) {
        if (row[trigger.column] !== null) {
          affectedCells.push({ x: trigger.column, y: rowIndex });
          row[trigger.column] = null;
          destroyedCells += 1;
        }
      }
      events.push({
        ...trigger,
        order,
        eventId: `${lockEventId}:column-bomb:${columnBombOrdinal}`,
        affectedCells,
      });
    } else if (trigger.kind === "garbage-core") {
      garbageOrdinal += 1;
      const eventId = `${lockEventId}:garbage-core:${garbageOrdinal}`;
      garbageCoreEvents.push(eventId);
      events.push({ ...trigger, order, eventId, affectedCells: [] });
    } else if (trigger.kind === "glitch-core") {
      glitchOrdinal += 1;
      const eventId = `${lockEventId}:glitch-core:${glitchOrdinal}`;
      glitchEvents.push(eventId);
      events.push({ ...trigger, order, eventId, affectedCells: [] });
    } else if (trigger.kind === "blackout") {
      blackoutOrdinal += 1;
      const eventId = `${lockEventId}:blackout:${blackoutOrdinal}`;
      blackoutEvents.push(eventId);
      events.push({ ...trigger, order, eventId, affectedCells: [] });
    } else {
      barrierOrdinal += 1;
      const eventId = `${lockEventId}:barrier:${barrierOrdinal}`;
      barrierEvents.push(eventId);
      events.push({ ...trigger, order, eventId, affectedCells: [] });
    }
  }
  return {
    grid,
    garbageCoreEvents,
    glitchEvents,
    blackoutEvents,
    barrierEvents,
    events,
    destroyedCells,
  };
}
