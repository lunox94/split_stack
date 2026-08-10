import { getAbsoluteCells, getPieceCellKind } from "../domain/pieces";
import type {
  ActivePiece,
  GarbagePacket,
  Grid,
  PieceDescriptor,
  PlayerId,
  ReplacementMode,
  StatusState,
} from "../domain/types";
import { decodeGrid, type PlayerSnapshot } from "../network/snapshots";
import type {
  BoardRenderModel,
  RenderCellKind,
  RenderCellModel,
} from "../render/renderer";
import type { SimulationSnapshot } from "../domain/simulation";

function descriptorKind(descriptor: PieceDescriptor, index: number): RenderCellKind {
  return getPieceCellKind(descriptor, index);
}

function activePieceKey(
  playerId: PlayerId,
  active: ActivePiece | null,
  basePieceCursor: number,
  holdUsed: boolean,
): string | undefined {
  if (active === null) return undefined;
  const descriptor = active.descriptor;
  return [
    playerId,
    basePieceCursor,
    holdUsed ? 1 : 0,
    descriptor.eventId ?? "base",
    descriptor.source,
    descriptor.shape,
    descriptor.crossVariant ?? "",
    descriptor.specialKind ?? "ordinary",
    descriptor.specialCellIndex ?? -1,
  ].join(":");
}

function gridCells(grid: Grid): RenderCellModel[] {
  const cells: RenderCellModel[] = [];
  grid.forEach((row, rowIndex) => {
    row.forEach((cell, column) => {
      if (cell === null) return;
      const model: RenderCellModel = {
        column,
        row: rowIndex,
        kind: cell.kind,
        role: "settled",
      };
      if (cell.special !== undefined) {
        cells.push({ ...model, special: cell.special });
      } else {
        cells.push(model);
      }
    });
  });
  return cells;
}

function fallingCells(
  active: ActivePiece | null,
  y: number | null,
  role: "active" | "ghost",
): RenderCellModel[] {
  if (active === null || y === null) return [];
  const projected = y === active.y ? active : { ...active, y };
  return getAbsoluteCells(projected).map((cell) => {
    const model: RenderCellModel = {
      column: cell.x,
      row: cell.y,
      kind: descriptorKind(active.descriptor, cell.index),
      role,
    };
    return cell.index === active.descriptor.specialCellIndex &&
      active.descriptor.specialKind !== undefined
      ? { ...model, special: active.descriptor.specialKind }
      : model;
  });
}

function boardModel(
  playerId: PlayerId,
  grid: Grid,
  active: ActivePiece | null,
  ghostY: number | null,
  focused: boolean,
  concealed: boolean,
  statuses: readonly StatusState[],
  incomingGarbage: readonly GarbagePacket[],
  replacementMode: ReplacementMode | null,
  pieceKey: string | undefined,
): BoardRenderModel {
  const barrier = statuses.find(
    (status): status is Extract<StatusState, { kind: "barrier" }> =>
      status.kind === "barrier",
  );
  const visibleGhostY = statuses.some((status) => status.kind === "ghost-jam")
    ? null
    : ghostY;
  return {
    playerId,
    ...(pieceKey === undefined ? {} : { activePieceKey: pieceKey }),
    focused,
    concealed,
    incomingGarbage: incomingGarbage.reduce((rows, packet) => rows + packet.rows, 0),
    barrierCapacity: barrier?.capacity ?? 0,
    scrambled: statuses.some((status) => status.kind === "scramble"),
    monominoRush: replacementMode?.kind === "monomino-rush",
    cells: concealed
      ? []
      : [
          ...gridCells(grid),
          ...fallingCells(active, visibleGhostY, "ghost"),
          ...fallingCells(active, active?.y ?? null, "active"),
        ],
  };
}

export function boardModelFromSimulation(
  snapshot: SimulationSnapshot,
  focused: boolean,
  concealed: boolean,
): BoardRenderModel {
  return boardModel(
    snapshot.player.playerId,
    snapshot.player.grid,
    snapshot.player.active,
    snapshot.ghostY,
    focused,
    concealed,
    snapshot.player.statuses,
    snapshot.player.incomingGarbage,
    snapshot.player.replacementMode,
    activePieceKey(
      snapshot.player.playerId,
      snapshot.player.active,
      snapshot.player.basePieceCursor,
      snapshot.player.holdUsed,
    ),
  );
}

export function boardModelFromRemoteSnapshot(
  snapshot: PlayerSnapshot,
  focused: boolean,
  concealed: boolean,
): BoardRenderModel {
  return boardModel(
    snapshot.playerId,
    decodeGrid(snapshot.grid),
    snapshot.active,
    snapshot.ghostRow,
    focused,
    concealed,
    snapshot.statuses,
    snapshot.incomingGarbage,
    snapshot.replacementMode,
    activePieceKey(
      snapshot.playerId,
      snapshot.active,
      snapshot.basePieceCursor,
      snapshot.holdUsed,
    ),
  );
}
