import { describe, expect, it } from "vitest";

import {
  MARKED_CELL_PULSE_DURATION_MS,
  MarkedCellPulseTracker,
} from "../../src/render/marked-cell-pulses";
import type {
  BoardRenderModel,
  GameRenderFrame,
  RenderCellModel,
} from "../../src/render/renderer";

const marked = (
  role: RenderCellModel["role"],
  column: number,
  row: number,
): RenderCellModel => ({
  role,
  column,
  row,
  kind: "T",
  special: "glitch-core",
});

const board = (
  activePieceKey: string,
  cells: readonly RenderCellModel[],
  concealed = false,
): BoardRenderModel => ({
  playerId: "player-a",
  activePieceKey,
  cells,
  concealed,
  focused: true,
});

const frame = (model: BoardRenderModel): GameRenderFrame => ({
  mode: "practice",
  left: model,
  right: null,
});

const emphasizedCell = (rendered: GameRenderFrame): RenderCellModel | undefined =>
  rendered.left?.cells.find((cell) => cell.specialEmphasis !== undefined);

describe("marked-cell pulse tracker", () => {
  it("pulses a marked spawn once and follows that piece without retriggering on movement", () => {
    const tracker = new MarkedCellPulseTracker();
    const spawned = tracker.decorateFrame(
      frame(board("piece-1", [marked("active", 4, 2)])),
      1_000,
    );
    const moved = tracker.decorateFrame(
      frame(board("piece-1", [marked("active", 5, 7)])),
      1_100,
    );
    const expired = tracker.decorateFrame(
      frame(board("piece-1", [marked("active", 5, 12)])),
      1_000 + MARKED_CELL_PULSE_DURATION_MS,
    );

    expect(emphasizedCell(spawned)?.specialEmphasis).toBe(1);
    expect(emphasizedCell(moved)?.specialEmphasis).toBeGreaterThan(0);
    expect(emphasizedCell(moved)?.specialEmphasis).toBeLessThan(1);
    expect(emphasizedCell(expired)).toBeUndefined();
  });

  it("moves emphasis from the active marker to its newly settled lock cell", () => {
    const tracker = new MarkedCellPulseTracker();
    tracker.decorateFrame(
      frame(board("piece-1", [marked("active", 4, 5)])),
      0,
    );

    const locked = tracker.decorateFrame(
      frame(board("piece-2", [
        marked("settled", 4, 18),
        { role: "active", column: 4, row: 2, kind: "I" },
      ])),
      100,
    );
    const settling = tracker.decorateFrame(
      frame(board("piece-2", [
        marked("settled", 4, 18),
        { role: "active", column: 5, row: 3, kind: "I" },
      ])),
      200,
    );

    expect(emphasizedCell(locked)).toMatchObject({
      role: "settled",
      column: 4,
      row: 18,
      specialEmphasis: 1,
    });
    expect(emphasizedCell(settling)?.specialEmphasis).toBeGreaterThan(0);
    expect(emphasizedCell(settling)?.specialEmphasis).toBeLessThan(1);
  });

  it("does not mistake unrelated settled-grid changes or reveal for a lock", () => {
    const tracker = new MarkedCellPulseTracker();
    tracker.decorateFrame(
      frame(board("piece-1", [{ role: "active", column: 4, row: 2, kind: "I" }])),
      0,
    );
    const unrelated = tracker.decorateFrame(
      frame(board("piece-1", [
        { role: "active", column: 4, row: 3, kind: "I" },
        marked("settled", 2, 19),
      ])),
      50,
    );
    tracker.decorateFrame(frame(board("piece-2", [], true)), 100);
    const revealed = tracker.decorateFrame(
      frame(board("piece-2", [marked("active", 4, 4)])),
      150,
    );

    expect(emphasizedCell(unrelated)).toBeUndefined();
    expect(emphasizedCell(revealed)).toBeUndefined();
  });

  it("is deterministic for the same frame and timestamp sequence", () => {
    const frames = [
      [frame(board("piece-1", [marked("active", 4, 2)])), 0],
      [frame(board("piece-1", [marked("active", 5, 8)])), 120],
      [frame(board("piece-2", [marked("settled", 5, 18)])), 240],
    ] as const;
    const left = new MarkedCellPulseTracker();
    const right = new MarkedCellPulseTracker();

    expect(frames.map(([nextFrame, atMs]) => left.decorateFrame(nextFrame, atMs)))
      .toEqual(frames.map(([nextFrame, atMs]) => right.decorateFrame(nextFrame, atMs)));
  });
});
