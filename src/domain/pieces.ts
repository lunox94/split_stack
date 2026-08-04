import type {
  ActivePiece,
  Coordinate,
  FallingShape,
  OversizeShape,
  PieceDescriptor,
  Rotation,
  StandardShape,
} from "./types";
import { RULES } from "../config/rules";

export interface IndexedCoordinate extends Coordinate {
  readonly index: number;
}

const STANDARD_SHAPE_SET: ReadonlySet<string> = new Set([
  "I", "J", "L", "O", "S", "T", "Z",
]);

const STANDARD_SPAWN_CELLS = {
  I: [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }],
  J: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
  L: [{ x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
  O: [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
  S: [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
  T: [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
  Z: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
} as const satisfies Record<string, readonly Coordinate[]>;

const OVERSIZE_SPAWN_CELLS = {
  I: [
    { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 },
    { x: 3, y: 2 }, { x: 4, y: 2 },
  ],
  J: [
    { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 },
    { x: 1, y: 2 }, { x: 2, y: 2 },
  ],
  L: [
    { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 2 },
    { x: 1, y: 2 }, { x: 2, y: 2 },
  ],
  S: [
    { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 },
    { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 },
  ],
  T: [
    { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 },
    { x: 3, y: 1 }, { x: 4, y: 1 }, { x: 2, y: 2 },
    { x: 2, y: 3 },
  ],
  Z: [
    { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 },
    { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 },
  ],
} as const satisfies Record<OversizeShape, readonly Coordinate[]>;

const OVERSIZE_PIVOTS = {
  I: { x: 2, y: 2 },
  J: { x: 1, y: 1 },
  L: { x: 1, y: 1 },
  S: { x: 1.5, y: 1.5 },
  T: { x: 2, y: 2 },
  Z: { x: 1.5, y: 1.5 },
} as const satisfies Record<OversizeShape, Coordinate>;

function rotateClockwise(cell: Coordinate, pivot: Coordinate): Coordinate {
  const relativeX = cell.x - pivot.x;
  const relativeY = cell.y - pivot.y;
  return {
    x: pivot.x - relativeY,
    y: pivot.y + relativeX,
  };
}

export function getPieceCells(
  shape: FallingShape,
  rotation: Rotation,
): readonly IndexedCoordinate[] {
  if (shape === "cross") {
    return RULES.hollowCross.cells.map(([x, y], index) => ({ x, y, index }));
  }
  if (shape === "monomino" || shape === "acid") {
    return [{ x: 0, y: 0, index: 0 }];
  }
  if (!(shape in STANDARD_SPAWN_CELLS)) throw new Error(`Unsupported shape: ${shape}`);

  let cells: readonly Coordinate[] = STANDARD_SPAWN_CELLS[
    shape as keyof typeof STANDARD_SPAWN_CELLS
  ];
  if (shape !== "O") {
    const pivot = shape === "I" ? { x: 1.5, y: 1.5 } : { x: 1, y: 1 };
    for (let turn = 0; turn < rotation; turn += 1) {
      cells = cells.map((cell) => rotateClockwise(cell, pivot));
    }
  }
  return cells.map((cell, index) => ({ ...cell, index }));
}

export function getDescriptorCells(
  descriptor: PieceDescriptor,
  rotation: Rotation,
): readonly IndexedCoordinate[] {
  if (descriptor.source !== "oversize") {
    return getPieceCells(descriptor.shape, rotation);
  }
  if (descriptor.shape === "O" || !isStandardShape(descriptor.shape)) {
    throw new TypeError(`Unsupported Oversize shape: ${descriptor.shape}`);
  }
  const shape = descriptor.shape as OversizeShape;
  let cells: readonly Coordinate[] = OVERSIZE_SPAWN_CELLS[shape];
  const pivot = OVERSIZE_PIVOTS[shape];
  for (let turn = 0; turn < rotation; turn += 1) {
    cells = cells.map((cell) => rotateClockwise(cell, pivot));
  }
  return cells.map((cell, index) => ({ ...cell, index }));
}

export function getAbsoluteCells(piece: ActivePiece): readonly IndexedCoordinate[] {
  return getDescriptorCells(piece.descriptor, piece.rotation).map((cell) => ({
    x: piece.x + cell.x,
    y: piece.y + cell.y,
    index: cell.index,
  }));
}

export function isStandardShape(shape: FallingShape): shape is StandardShape {
  return STANDARD_SHAPE_SET.has(shape);
}

export function isHoldable(descriptor: PieceDescriptor): boolean {
  return (
    (descriptor.source === "base" || descriptor.source === "oversize") &&
    isStandardShape(descriptor.shape) &&
    (descriptor.source !== "oversize" || descriptor.shape !== "O")
  );
}

export function getSpawnPosition(descriptor: PieceDescriptor): Coordinate {
  if (descriptor.shape === "cross") {
    return { x: RULES.hollowCross.spawnX, y: RULES.hollowCross.spawnY };
  }
  if (descriptor.shape === "monomino" || descriptor.shape === "acid") {
    return { x: Math.floor((RULES.board.width - 1) / 2), y: 0 };
  }
  if (descriptor.source === "oversize") {
    const cells = getDescriptorCells(descriptor, 0);
    const minX = Math.min(...cells.map((cell) => cell.x));
    const maxX = Math.max(...cells.map((cell) => cell.x));
    const width = maxX - minX + 1;
    return { x: Math.floor((RULES.board.width - width) / 2) - minX, y: 0 };
  }
  return { x: 3, y: 0 };
}
