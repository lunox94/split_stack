import { getAbsoluteCells } from "../domain/pieces";
import type { ActivePiece, Grid, PieceDescriptor, PlayerId } from "../domain/types";
import { decodeGrid, type PlayerSnapshotV1 } from "../network/snapshots";
import type {
  BoardRenderModel,
  RenderCellKind,
  RenderCellModel,
} from "../render/renderer";
import type { SimulationSnapshot } from "../domain/simulation";

function descriptorKind(descriptor: PieceDescriptor): RenderCellKind {
  return descriptor.shape;
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
      kind: descriptorKind(active.descriptor),
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
): BoardRenderModel {
  return {
    playerId,
    focused,
    concealed,
    cells: concealed
      ? []
      : [
          ...gridCells(grid),
          ...fallingCells(active, ghostY, "ghost"),
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
  );
}

export function boardModelFromRemoteSnapshot(
  snapshot: PlayerSnapshotV1,
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
  );
}

