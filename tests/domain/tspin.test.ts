import { describe, expect, it } from "vitest";
import { createBoard } from "../../src/domain/board";
import { classifyTSpin } from "../../src/domain/tspin";
import type { ActivePiece } from "../../src/domain/types";

function active(lastSuccessfulAction: ActivePiece["lastSuccessfulAction"]): ActivePiece {
  const piece: ActivePiece = {
    descriptor: { source: "base", shape: "T" },
    x: 3,
    y: 10,
    rotation: 0,
    lockTicksRemaining: 0,
    lockResetCount: 0,
  };
  if (lastSuccessfulAction !== undefined) piece.lastSuccessfulAction = lastSuccessfulAction;
  return piece;
}

describe("simplified T-Spin recognition", () => {
  it("recognizes three occupied pivot corners after a rotation", () => {
    const grid = createBoard();
    grid[10]![3] = { kind: "garbage" };
    grid[10]![5] = { kind: "garbage" };
    grid[12]![3] = { kind: "garbage" };

    expect(classifyTSpin(grid, active("rotate-cw"), 2)).toBe("t-spin-double");
  });

  it("does not recognize the same enclosure when hard drop was the last action", () => {
    const grid = createBoard();
    grid[10]![3] = { kind: "garbage" };
    grid[10]![5] = { kind: "garbage" };
    grid[12]![3] = { kind: "garbage" };

    expect(classifyTSpin(grid, active("hard-drop"), 2)).toBe("double");
  });

  it("counts outside-board corners as occupied", () => {
    const piece = active("rotate-ccw");
    piece.x = -1;
    piece.y = -1;
    const grid = createBoard();

    expect(classifyTSpin(grid, piece, 0)).toBe("t-spin-none");
  });

  it("never classifies an Oversize T as a T-Spin", () => {
    const piece = active("rotate-cw");
    piece.descriptor = { source: "oversize", shape: "T" };
    const grid = createBoard();
    grid[10]![3] = { kind: "garbage" };
    grid[10]![5] = { kind: "garbage" };
    grid[12]![3] = { kind: "garbage" };

    expect(classifyTSpin(grid, piece, 2)).toBe("double");
  });
});
