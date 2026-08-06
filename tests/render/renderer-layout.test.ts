import { describe, expect, it } from "vitest";

import { calculateRendererLayout } from "../../src/render/renderer";

describe("renderer board-relative HUD layout", () => {
  it("packs equal PvP boards around a fixed 54px center corridor", () => {
    const layout = calculateRendererLayout(1280, 720, "versus");

    expect(layout.safeBounds).toEqual({ x: 8, y: 4, width: 1264, height: 712 });
    expect(layout.frame).toEqual({ x: 318, y: 4, width: 644, height: 712 });
    expect(layout.compactTopHud).toBe(false);
    expect(layout.topHudHeight).toBe(72);
    expect(layout.centerCorridor).toEqual({ x: 613, y: 80, width: 54, height: 590 });

    expect(layout.left.cellSize).toBeCloseTo(29.5);
    expect(layout.left.boardX).toBeCloseTo(318);
    expect(layout.left.boardY).toBeCloseTo(80);
    expect(layout.left.boardWidth).toBeCloseTo(295);
    expect(layout.left.boardHeight).toBeCloseTo(590);
    expect(layout.left.hud.header).toEqual({ x: 318, y: 4, width: 295, height: 72 });
    expect(layout.left.hud.rail).toEqual({ x: 617, y: 80, width: 22, height: 590 });
    expect(layout.left.hud.timers).toEqual({ x: 318, y: 676, width: 295, height: 40 });
    expect(layout.left.hud.garbage).toEqual({ x: 617, y: 676, width: 22, height: 40 });

    expect(layout.right?.cellSize).toBeCloseTo(29.5);
    expect(layout.right?.boardX).toBeCloseTo(667);
    expect(layout.right?.boardY).toBeCloseTo(80);
    expect(layout.right?.boardWidth).toBeCloseTo(295);
    expect(layout.right?.boardHeight).toBeCloseTo(590);
    expect(layout.right?.hud.header).toEqual({ x: 667, y: 4, width: 295, height: 72 });
    expect(layout.right?.hud.rail).toEqual({ x: 641, y: 80, width: 22, height: 590 });
    expect(layout.right?.hud.timers).toEqual({ x: 667, y: 676, width: 295, height: 40 });
    expect(layout.right?.hud.garbage).toEqual({ x: 641, y: 676, width: 22, height: 40 });
    expect(layout.dividerX).toBeNull();
  });

  it("centers the Practice board and rail with a compact HUD when the board is narrow", () => {
    const layout = calculateRendererLayout(640, 360, "practice");

    expect(layout.safeBounds).toEqual({ x: 8, y: 4, width: 624, height: 352 });
    expect(layout.frame).toEqual({ x: 247.5, y: 4, width: 145, height: 352 });
    expect(layout.compactTopHud).toBe(true);
    expect(layout.topHudHeight).toBe(64);
    expect(layout.centerCorridor).toBeNull();
    expect(layout.left.cellSize).toBeCloseTo(11.9);
    expect(layout.left.boardX).toBeCloseTo(247.5);
    expect(layout.left.boardY).toBeCloseTo(72);
    expect(layout.left.boardWidth).toBeCloseTo(119);
    expect(layout.left.boardHeight).toBeCloseTo(238);
    expect(layout.left.hud.header).toEqual({ x: 247.5, y: 4, width: 119, height: 64 });
    expect(layout.left.hud.rail).toEqual({ x: 370.5, y: 72, width: 22, height: 238 });
    expect(layout.left.hud.timers).toEqual({ x: 247.5, y: 316, width: 119, height: 40 });
    expect(layout.left.hud.garbage).toEqual({ x: 370.5, y: 316, width: 22, height: 40 });
  });

  it("centers the complete frame inside safe areas and above touch controls", () => {
    const layout = calculateRendererLayout(400, 800, "practice", {
      safeAreaInsets: { top: 20, right: 12, bottom: 24, left: 16 },
      bottomInset: 80,
    });

    expect(layout.safeBounds).toEqual({ x: 24, y: 24, width: 356, height: 668 });
    expect(layout.frame).toEqual({ x: 52.5, y: 24, width: 299, height: 668 });
    expect(layout.compactTopHud).toBe(false);
    expect(layout.left.cellSize).toBeCloseTo(27.3);
    expect(layout.left.boardX).toBeCloseTo(52.5);
    expect(layout.left.boardY).toBeCloseTo(100);
    expect(layout.left.boardWidth).toBeCloseTo(273);
    expect(layout.left.boardHeight).toBeCloseTo(546);
    expect(layout.left.hud.rail).toEqual({ x: 329.5, y: 100, width: 22, height: 546 });
    expect(layout.left.hud.timers).toEqual({ x: 52.5, y: 652, width: 273, height: 40 });
    expect(layout.left.hud.garbage).toEqual({ x: 329.5, y: 652, width: 22, height: 40 });
  });

  it("moves the PvP pane split with an asymmetric safe area", () => {
    const layout = calculateRendererLayout(400, 800, "versus", {
      safeAreaInsets: { left: 20 },
    });

    expect(layout.safeBounds).toEqual({ x: 28, y: 4, width: 364, height: 792 });
    expect(layout.left.paneX).toBe(0);
    expect(layout.left.paneWidth).toBeCloseTo(210);
    expect(layout.right?.paneX).toBeCloseTo(210);
    expect(layout.right?.paneWidth).toBeCloseTo(190);
    expect(layout.left.hud.rail.x + layout.left.hud.rail.width).toBeCloseTo(209);
    expect(layout.right?.hud.rail.x).toBeCloseTo(211);
  });

  it("keeps narrow PvP boards equal while preserving the packed corridor", () => {
    const layout = calculateRendererLayout(360, 640, "versus");

    expect(layout.frame).toEqual({ x: 8, y: 118, width: 344, height: 404 });
    expect(layout.compactTopHud).toBe(true);
    expect(layout.topHudHeight).toBe(64);
    expect(layout.left.boardWidth).toBeCloseTo(145);
    expect(layout.right?.boardWidth).toBeCloseTo(145);
    expect(layout.left.boardHeight).toBeCloseTo(290);
    expect(layout.right?.boardHeight).toBeCloseTo(290);
    expect(layout.centerCorridor).toEqual({ x: 153, y: 186, width: 54, height: 290 });
    expect(layout.left.hud.rail).toEqual({ x: 157, y: 186, width: 22, height: 290 });
    expect(layout.right?.hud.rail).toEqual({ x: 181, y: 186, width: 22, height: 290 });
    expect(layout.right?.boardX).toBeCloseTo(207);
  });

  it("lets a tall Practice board grow after reserving both fixed bands", () => {
    const desktop = calculateRendererLayout(1280, 720, "practice");
    const tall = calculateRendererLayout(1280, 1400, "practice");

    expect(desktop.left.boardWidth).toBeCloseTo(295);
    expect(tall.left.boardWidth).toBeCloseTo(635);
    expect(tall.left.boardHeight).toBeCloseTo(1270);
    expect(tall.frame).toEqual({ x: 309.5, y: 4, width: 661, height: 1392 });
    expect(tall.left.hud.header.height).toBe(72);
    expect(tall.left.hud.timers.height).toBe(40);
    expect(tall.left.hud.rail.width).toBe(22);
  });
});
