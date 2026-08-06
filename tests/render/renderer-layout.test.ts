import { describe, expect, it } from "vitest";

import { calculateRendererLayout } from "../../src/render/renderer";

describe("renderer board-relative HUD layout", () => {
  it("shifts versus boards four pixels outward without shrinking their cells", () => {
    const layout = calculateRendererLayout(400, 800, "versus");

    expect(layout.left.cellSize).toBeCloseTo(17.6);
    expect(layout.left.boardX).toBeCloseTo(8);
    expect(layout.left.boardWidth).toBeCloseTo(176);
    expect(layout.right?.cellSize).toBeCloseTo(17.6);
    expect(layout.right?.boardX).toBeCloseTo(216);
    expect(layout.right?.boardWidth).toBeCloseTo(176);
  });

  it("shifts the Practice board left to reserve its right-hand power rail", () => {
    const layout = calculateRendererLayout(400, 800, "practice");

    expect(layout.left.cellSize).toBeCloseTo(37.6);
    expect(layout.left.boardX).toBeCloseTo(8);
    expect(layout.left.boardWidth).toBeCloseTo(376);
  });
});
