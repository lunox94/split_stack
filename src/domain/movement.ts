import { RULES } from "../config/rules";
import { canSpawn, collides, isGrounded } from "./collision";
import { getSpawnPosition, isStandardShape } from "./pieces";
import {
  getKickTests,
  getOversizeKickTests,
  nextRotation,
  type RotationDirection,
} from "./srs";
import type { ActivePiece, Grid, PieceDescriptor } from "./types";

export function spawnPiece(grid: Grid, descriptor: PieceDescriptor): ActivePiece | null {
  if (!canSpawn(grid, descriptor)) return null;
  return {
    descriptor,
    ...getSpawnPosition(descriptor),
    rotation: 0,
    lockTicksRemaining: RULES.timing.lockDelayTicks,
    lockResetCount: 0,
  };
}

export function tryMove(
  grid: Grid,
  piece: ActivePiece,
  deltaX: number,
  deltaY: number,
  action: "move" | "soft-drop" = deltaY > 0 ? "soft-drop" : "move",
): ActivePiece | null {
  if (Math.abs(deltaX) + Math.abs(deltaY) !== 1) {
    throw new RangeError("Movement must advance exactly one logical cell");
  }
  const moved: ActivePiece = {
    ...piece,
    x: piece.x + deltaX,
    y: piece.y + deltaY,
    lastSuccessfulAction: action,
  };
  if (collides(grid, moved)) return null;
  return action === "move" ? resetLockDelayIfGrounded(grid, piece, moved) : moved;
}

export function tryGravityStep(grid: Grid, piece: ActivePiece): ActivePiece | null {
  const fallen = { ...piece, y: piece.y + 1 };
  return collides(grid, fallen) ? null : fallen;
}

export function resetLockDelayIfGrounded(
  grid: Grid,
  beforeAction: ActivePiece,
  afterAction: ActivePiece = beforeAction,
): ActivePiece {
  if (
    !isGrounded(grid, beforeAction)
    || beforeAction.lockResetCount >= RULES.timing.lockResetCap
  ) {
    return afterAction;
  }
  return {
    ...afterAction,
    lockTicksRemaining: RULES.timing.lockDelayTicks,
    lockResetCount: beforeAction.lockResetCount + 1,
  };
}

export function tryRotate(
  grid: Grid,
  piece: ActivePiece,
  direction: RotationDirection,
): ActivePiece | null {
  if (!isStandardShape(piece.descriptor.shape)) return null;
  if (piece.descriptor.shape === "O") return null;

  const rotation = nextRotation(piece.rotation, direction);
  const kicks = piece.descriptor.source === "oversize"
    ? getOversizeKickTests(piece.rotation, rotation)
    : getKickTests(piece.descriptor.shape, piece.rotation, rotation);
  for (const kick of kicks) {
    const rotated: ActivePiece = {
      ...piece,
      x: piece.x + kick.x,
      y: piece.y + kick.y,
      rotation,
      lastSuccessfulAction: direction === "cw" ? "rotate-cw" : "rotate-ccw",
    };
    if (!collides(grid, rotated)) {
      return resetLockDelayIfGrounded(grid, piece, rotated);
    }
  }
  return null;
}

export function getGhostY(grid: Grid, piece: ActivePiece): number {
  if (collides(grid, piece)) throw new RangeError("Cannot project a colliding piece");
  let landingY = piece.y;
  while (!collides(grid, { ...piece, y: landingY + 1 })) landingY += 1;
  return landingY;
}

export function getDropDistance(grid: Grid, piece: ActivePiece): number {
  return getGhostY(grid, piece) - piece.y;
}

export interface HardDropResult {
  readonly piece: ActivePiece;
  readonly distance: number;
}

export function hardDrop(grid: Grid, piece: ActivePiece): HardDropResult {
  const landingY = getGhostY(grid, piece);
  return {
    distance: landingY - piece.y,
    piece: {
      ...piece,
      y: landingY,
      lockTicksRemaining: 0,
      lastSuccessfulAction: "hard-drop",
    },
  };
}
