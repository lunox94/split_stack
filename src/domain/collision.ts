import { RULES } from "../config/rules";
import { getAbsoluteCells, getSpawnPosition } from "./pieces";
import type { ActivePiece, Grid, PieceDescriptor } from "./types";

export function collides(grid: Grid, piece: ActivePiece): boolean {
  return getAbsoluteCells(piece).some(({ x, y }) => (
    x < 0
    || x >= RULES.board.width
    || y < 0
    || y >= RULES.board.height
    || grid[y]?.[x] !== null
  ));
}

export function isGrounded(grid: Grid, piece: ActivePiece): boolean {
  return collides(grid, { ...piece, y: piece.y + 1 });
}

export function canSpawn(grid: Grid, descriptor: PieceDescriptor): boolean {
  const spawn = getSpawnPosition(descriptor);
  return !collides(grid, {
    descriptor,
    ...spawn,
    rotation: 0,
    lockTicksRemaining: RULES.timing.lockDelayTicks,
    lockResetCount: 0,
  });
}
