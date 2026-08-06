import { describe, expect, it } from "vitest";

import { calculateRendererLayout } from "../../src/render/renderer";

describe("renderer board-relative HUD layout", () => {
  it("packs equal PvP boards around a fixed 58px center corridor", () => {
    const layout = calculateRendererLayout(1280, 720, "versus");

    expect(layout.safeBounds).toEqual({ x: 8, y: 4, width: 1264, height: 712 });
    expect(layout.frame).toEqual({ x: 315, y: 4, width: 650, height: 712 });
    expect(layout.compactTopHud).toBe(false);
    expect(layout.topHudHeight).toBe(72);
    expect(layout.centerCorridor).toEqual({ x: 611, y: 80, width: 58, height: 592 });

    expect(layout.left.cellSize).toBeCloseTo(29.6);
    expect(layout.left.boardX).toBeCloseTo(315);
    expect(layout.left.boardY).toBeCloseTo(80);
    expect(layout.left.boardWidth).toBeCloseTo(296);
    expect(layout.left.boardHeight).toBeCloseTo(592);
    expect(layout.left.hud.header).toEqual({ x: 315, y: 4, width: 296, height: 72 });
    expect(layout.left.hud.rail).toEqual({ x: 615, y: 80, width: 24, height: 592 });
    expect(layout.left.hud.timers).toEqual({ x: 315, y: 676, width: 296, height: 40 });
    expect(layout.left.hud.garbage).toEqual({ x: 615, y: 676, width: 24, height: 40 });

    expect(layout.right?.cellSize).toBeCloseTo(29.6);
    expect(layout.right?.boardX).toBeCloseTo(669);
    expect(layout.right?.boardY).toBeCloseTo(80);
    expect(layout.right?.boardWidth).toBeCloseTo(296);
    expect(layout.right?.boardHeight).toBeCloseTo(592);
    expect(layout.right?.hud.header).toEqual({ x: 669, y: 4, width: 296, height: 72 });
    expect(layout.right?.hud.rail).toEqual({ x: 641, y: 80, width: 24, height: 592 });
    expect(layout.right?.hud.timers).toEqual({ x: 669, y: 676, width: 296, height: 40 });
    expect(layout.right?.hud.garbage).toEqual({ x: 641, y: 676, width: 24, height: 40 });
    expect(layout.dividerX).toBeNull();
  });

  it("centers the Practice board and rail with a compact HUD when the board is narrow", () => {
    const layout = calculateRendererLayout(640, 360, "practice");

    expect(layout.safeBounds).toEqual({ x: 8, y: 4, width: 624, height: 352 });
    expect(layout.frame).toEqual({ x: 246, y: 4, width: 148, height: 352 });
    expect(layout.compactTopHud).toBe(true);
    expect(layout.topHudHeight).toBe(64);
    expect(layout.centerCorridor).toBeNull();
    expect(layout.left.cellSize).toBeCloseTo(12);
    expect(layout.left.boardX).toBeCloseTo(246);
    expect(layout.left.boardY).toBeCloseTo(72);
    expect(layout.left.boardWidth).toBeCloseTo(120);
    expect(layout.left.boardHeight).toBeCloseTo(240);
    expect(layout.left.hud.header).toEqual({ x: 246, y: 4, width: 120, height: 64 });
    expect(layout.left.hud.rail).toEqual({ x: 370, y: 72, width: 24, height: 240 });
    expect(layout.left.hud.timers).toEqual({ x: 246, y: 316, width: 120, height: 40 });
    expect(layout.left.hud.garbage).toEqual({ x: 370, y: 316, width: 24, height: 40 });
  });

  it("centers the complete frame inside safe areas and above touch controls", () => {
    const layout = calculateRendererLayout(400, 800, "practice", {
      safeAreaInsets: { top: 20, right: 12, bottom: 24, left: 16 },
      bottomInset: 80,
    });

    expect(layout.safeBounds).toEqual({ x: 24, y: 24, width: 356, height: 668 });
    expect(layout.frame).toEqual({ x: 51, y: 24, width: 302, height: 668 });
    expect(layout.compactTopHud).toBe(false);
    expect(layout.left.cellSize).toBeCloseTo(27.4);
    expect(layout.left.boardX).toBeCloseTo(51);
    expect(layout.left.boardY).toBeCloseTo(100);
    expect(layout.left.boardWidth).toBeCloseTo(274);
    expect(layout.left.boardHeight).toBeCloseTo(548);
    expect(layout.left.hud.rail).toEqual({ x: 329, y: 100, width: 24, height: 548 });
    expect(layout.left.hud.timers).toEqual({ x: 51, y: 652, width: 274, height: 40 });
    expect(layout.left.hud.garbage).toEqual({ x: 329, y: 652, width: 24, height: 40 });
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

    expect(layout.frame).toEqual({ x: 8, y: 121, width: 344, height: 398 });
    expect(layout.compactTopHud).toBe(true);
    expect(layout.topHudHeight).toBe(64);
    expect(layout.left.boardWidth).toBeCloseTo(143);
    expect(layout.right?.boardWidth).toBeCloseTo(143);
    expect(layout.left.boardHeight).toBeCloseTo(286);
    expect(layout.right?.boardHeight).toBeCloseTo(286);
    expect(layout.centerCorridor).toEqual({ x: 151, y: 189, width: 58, height: 286 });
    expect(layout.left.hud.rail).toEqual({ x: 155, y: 189, width: 24, height: 286 });
    expect(layout.right?.hud.rail).toEqual({ x: 181, y: 189, width: 24, height: 286 });
    expect(layout.right?.boardX).toBeCloseTo(209);
  });

  it("lets a tall Practice board grow after reserving both fixed bands", () => {
    const desktop = calculateRendererLayout(1280, 720, "practice");
    const tall = calculateRendererLayout(1280, 1400, "practice");

    expect(desktop.left.boardWidth).toBeCloseTo(296);
    expect(tall.left.boardWidth).toBeCloseTo(636);
    expect(tall.left.boardHeight).toBeCloseTo(1272);
    expect(tall.frame).toEqual({ x: 308, y: 4, width: 664, height: 1392 });
    expect(tall.left.hud.header.height).toBe(72);
    expect(tall.left.hud.timers.height).toBe(40);
    expect(tall.left.hud.rail.width).toBe(24);
  });
});
