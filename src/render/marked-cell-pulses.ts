import type { SpecialKind } from "../domain/types";
import type {
  BoardRenderModel,
  GameRenderFrame,
  RenderCellModel,
} from "./renderer";

export const MARKED_CELL_PULSE_DURATION_MS = 420;

interface MarkedPosition {
  readonly column: number;
  readonly row: number;
  readonly special: SpecialKind;
}

interface BoardPulseHistory {
  activePieceKey: string | null;
  activeSpecial: MarkedPosition | null;
  settledKeys: Set<string>;
  readonly pulses: Map<string, number>;
  suppressSpawnKey: string | null;
  lastTimestampMs: number;
}

const activePulseKey = (pieceKey: string): string => `active:${pieceKey}`;

const settledCellKey = (cell: MarkedPosition): string =>
  `${cell.special}:${cell.column}:${cell.row}`;

const settledPulseKey = (cell: MarkedPosition): string =>
  `settled:${settledCellKey(cell)}`;

const markedPosition = (cell: RenderCellModel): MarkedPosition | null =>
  cell.special === undefined
    ? null
    : { column: cell.column, row: cell.row, special: cell.special };

function activeSpecialOn(board: BoardRenderModel): MarkedPosition | null {
  for (const cell of board.cells) {
    if (cell.role !== "active") continue;
    const position = markedPosition(cell);
    if (position !== null) return position;
  }
  return null;
}

function settledSpecialsOn(
  board: BoardRenderModel,
): Map<string, MarkedPosition> {
  const settled = new Map<string, MarkedPosition>();
  for (const cell of board.cells) {
    if (cell.role !== "settled") continue;
    const position = markedPosition(cell);
    if (position !== null) settled.set(settledCellKey(position), position);
  }
  return settled;
}

function nearestPosition(
  origin: MarkedPosition,
  candidates: readonly MarkedPosition[],
): MarkedPosition | undefined {
  return [...candidates].sort((left, right) => {
    const leftDistance = Math.abs(left.column - origin.column) +
      Math.abs(left.row - origin.row);
    const rightDistance = Math.abs(right.column - origin.column) +
      Math.abs(right.row - origin.row);
    return leftDistance - rightDistance ||
      right.row - left.row ||
      left.column - right.column;
  })[0];
}

function emphasisAt(startedAtMs: number, timestampMs: number): number {
  const progress = Math.max(
    0,
    Math.min(1, (timestampMs - startedAtMs) / MARKED_CELL_PULSE_DURATION_MS),
  );
  return (1 - progress) ** 2;
}

/**
 * Derives short, presentation-only marker pulses from successive public render
 * frames. It keys active pieces independently of their moving coordinates and
 * only treats a new settled marker as a lock when the active piece transitions.
 */
export class MarkedCellPulseTracker {
  readonly #boards = new Map<string, BoardPulseHistory>();

  decorateFrame(frame: GameRenderFrame, timestampMs: number): GameRenderFrame {
    const visiblePlayers = new Set<string>();
    const decorate = (board: BoardRenderModel | null): BoardRenderModel | null => {
      if (board === null) return null;
      visiblePlayers.add(board.playerId);
      return this.#decorateBoard(board, timestampMs);
    };
    const left = decorate(frame.left);
    const right = decorate(frame.right);
    for (const playerId of this.#boards.keys()) {
      if (!visiblePlayers.has(playerId)) this.#boards.delete(playerId);
    }
    return left === frame.left && right === frame.right
      ? frame
      : { ...frame, left, right };
  }

  clear(): void {
    this.#boards.clear();
  }

  #decorateBoard(
    board: BoardRenderModel,
    timestampMs: number,
  ): BoardRenderModel {
    const currentPieceKey = board.activePieceKey ?? null;
    let history = this.#boards.get(board.playerId);
    if (history !== undefined && timestampMs < history.lastTimestampMs) {
      this.#boards.delete(board.playerId);
      history = undefined;
    }

    if (board.concealed) {
      const concealedHistory = history ?? {
        activePieceKey: currentPieceKey,
        activeSpecial: null,
        settledKeys: new Set<string>(),
        pulses: new Map<string, number>(),
        suppressSpawnKey: currentPieceKey,
        lastTimestampMs: timestampMs,
      };
      concealedHistory.activePieceKey = currentPieceKey;
      concealedHistory.activeSpecial = null;
      concealedHistory.settledKeys = new Set();
      concealedHistory.pulses.clear();
      concealedHistory.suppressSpawnKey = currentPieceKey;
      concealedHistory.lastTimestampMs = timestampMs;
      this.#boards.set(board.playerId, concealedHistory);
      return board;
    }

    const currentActiveSpecial = activeSpecialOn(board);
    const currentSettled = settledSpecialsOn(board);
    if (history === undefined) {
      history = {
        activePieceKey: currentPieceKey,
        activeSpecial: currentActiveSpecial,
        settledKeys: new Set(currentSettled.keys()),
        pulses: new Map(),
        suppressSpawnKey: null,
        lastTimestampMs: timestampMs,
      };
      if (currentPieceKey !== null && currentActiveSpecial !== null) {
        history.pulses.set(activePulseKey(currentPieceKey), timestampMs);
      }
      this.#boards.set(board.playerId, history);
    } else {
      for (const [key, startedAtMs] of history.pulses) {
        if (timestampMs - startedAtMs >= MARKED_CELL_PULSE_DURATION_MS) {
          history.pulses.delete(key);
        }
      }

      const activeTransition = history.activePieceKey !== currentPieceKey;
      if (activeTransition && history.activeSpecial !== null) {
        const exact = currentSettled.get(settledCellKey(history.activeSpecial));
        const newlySettled = [...currentSettled.entries()]
          .filter(([key, position]) =>
            !history!.settledKeys.has(key) &&
            position.special === history!.activeSpecial?.special
          )
          .map(([, position]) => position);
        const locked = exact ?? nearestPosition(history.activeSpecial, newlySettled);
        if (locked !== undefined) {
          history.pulses.set(settledPulseKey(locked), timestampMs);
        }
      }

      if (
        currentPieceKey !== null &&
        currentActiveSpecial !== null &&
        activeTransition &&
        currentPieceKey !== history.suppressSpawnKey
      ) {
        history.pulses.set(activePulseKey(currentPieceKey), timestampMs);
      }

      history.activePieceKey = currentPieceKey;
      history.activeSpecial = currentActiveSpecial;
      history.settledKeys = new Set(currentSettled.keys());
      history.suppressSpawnKey = null;
      history.lastTimestampMs = timestampMs;
    }

    if (history.pulses.size === 0) return board;
    let changed = false;
    const cells = board.cells.map((cell) => {
      if (cell.special === undefined) return cell;
      const position = markedPosition(cell)!;
      const pulseKey = cell.role === "active" && currentPieceKey !== null
        ? activePulseKey(currentPieceKey)
        : cell.role === "settled"
          ? settledPulseKey(position)
          : null;
      if (pulseKey === null) return cell;
      const startedAtMs = history.pulses.get(pulseKey);
      if (startedAtMs === undefined) return cell;
      const emphasis = emphasisAt(startedAtMs, timestampMs);
      if (emphasis <= 0) return cell;
      changed = true;
      return {
        ...cell,
        specialEmphasis: Math.max(cell.specialEmphasis ?? 0, emphasis),
      };
    });
    return changed ? { ...board, cells } : board;
  }
}
