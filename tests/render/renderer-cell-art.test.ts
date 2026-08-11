import { describe, expect, it } from "vitest";

import {
  COLORBLIND_PIECE_COLORS,
  PIECE_CELL_ART,
  PIECE_PATTERNS,
  STANDARD_PIECE_COLORS,
  type PieceVisualKind,
} from "../../src/render/piece-visual-tokens";

const VISUAL_KINDS = [
  "I",
  "J",
  "L",
  "O",
  "S",
  "T",
  "Z",
  "cross",
  "small-cross",
  "monomino",
  "garbage",
  "acid",
] as const satisfies readonly PieceVisualKind[];

const rgb = (hex: string): readonly [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

describe("renderer cell-art contract", () => {
  it("covers every renderable cell densely in both palettes with one pattern identity", () => {
    expect(Object.keys(STANDARD_PIECE_COLORS)).toEqual(VISUAL_KINDS);
    expect(Object.keys(COLORBLIND_PIECE_COLORS)).toEqual(VISUAL_KINDS);
    expect(Object.keys(PIECE_PATTERNS)).toEqual(VISUAL_KINDS);

    for (const kind of VISUAL_KINDS) {
      expect(STANDARD_PIECE_COLORS[kind]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(COLORBLIND_PIECE_COLORS[kind]).toMatch(/^#[0-9a-f]{6}$/i);
      const standard = rgb(STANDARD_PIECE_COLORS[kind]);
      const colorblind = rgb(COLORBLIND_PIECE_COLORS[kind]);
      expect(Math.hypot(
        standard[0] - colorblind[0],
        standard[1] - colorblind[1],
        standard[2] - colorblind[2],
      )).toBeGreaterThan(8);
    }
  });

  it("gives every tetromino a distinct non-color cue and reserves recognizable utility cues", () => {
    const tetrominoPatterns = VISUAL_KINDS.slice(0, 7).map(
      (kind) => PIECE_PATTERNS[kind],
    );
    expect(new Set(tetrominoPatterns).size).toBe(7);
    expect(PIECE_PATTERNS).toMatchObject({
      cross: "cross",
      "small-cross": "cross",
      monomino: "circle",
      garbage: "grid",
      acid: "bubbles",
    });
  });

  it("defines a compact rounded-square cell silhouette while Monomino keeps an interior cue", () => {
    expect(PIECE_CELL_ART).toMatchObject({
      inset: 0.91,
      cornerRadius: 0.18,
      markedGlyphFootprint: 0.46,
    });
    expect(PIECE_CELL_ART.cornerRadius).toBeLessThan(0.25);
    expect(PIECE_PATTERNS.monomino).toBe("circle");
  });

  it("keeps garbage neutral in both palettes so its grid remains its primary identity", () => {
    for (const palette of [STANDARD_PIECE_COLORS, COLORBLIND_PIECE_COLORS]) {
      const channels = rgb(palette.garbage);
      expect(Math.max(...channels) - Math.min(...channels)).toBeLessThan(32);
      expect(channels.every((channel) => channel >= 96 && channel <= 160)).toBe(true);
    }
    expect(PIECE_PATTERNS.garbage).toBe("grid");
  });
});
