import type { CellKind } from "../domain/types";

export type PieceVisualKind = CellKind | "acid";
export type PiecePattern =
  | "diagonal"
  | "vertical"
  | "horizontal"
  | "dots"
  | "chevron-left"
  | "crosses"
  | "chevron-right"
  | "cross"
  | "circle"
  | "grid"
  | "bubbles";

export const STANDARD_PIECE_COLORS = {
  I: "#20c8ee",
  J: "#4868e8",
  L: "#f4932f",
  O: "#f2d13f",
  S: "#45dc80",
  T: "#b95eeb",
  Z: "#f05b6d",
  cross: "#effb76",
  "small-cross": "#df5065",
  monomino: "#dceef8",
  garbage: "#737d90",
  acid: "#82ed50",
} as const satisfies Readonly<Record<PieceVisualKind, string>>;

export const COLORBLIND_PIECE_COLORS = {
  I: "#4caddd",
  J: "#0e6fae",
  L: "#e99b16",
  O: "#e8d82e",
  S: "#07976f",
  T: "#c873a4",
  Z: "#d75b12",
  cross: "#ffffff",
  "small-cross": "#f8f8ff",
  monomino: "#bde3f7",
  garbage: "#787878",
  acid: "#7fe51f",
} as const satisfies Readonly<Record<PieceVisualKind, string>>;

/**
 * Shared production targets for the prototype-inspired cell surface. The
 * renderer bakes light, bevel and pattern into one texture, so richer art does
 * not add a draw pass per cell. DOM previews mirror these proportions in CSS.
 */
export const PIECE_CELL_ART = {
  textureSize: 128,
  inset: 0.91,
  ghostInset: 0.74,
  cornerRadius: 0.18,
  garbageCornerRadius: 0.11,
  markedGlyphFootprint: 0.46,
  patternAlpha: {
    standard: 0.23,
    colorblind: 0.34,
  },
} as const;

export const PIECE_PATTERNS = {
  I: "diagonal",
  J: "vertical",
  L: "horizontal",
  O: "dots",
  S: "chevron-left",
  T: "crosses",
  Z: "chevron-right",
  cross: "cross",
  "small-cross": "cross",
  monomino: "circle",
  garbage: "grid",
  acid: "bubbles",
} as const satisfies Readonly<Record<PieceVisualKind, PiecePattern>>;

export type PiecePatternPrimitive =
  | {
      readonly kind: "line";
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly strokeWidth: number;
    }
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "circle";
      readonly x: number;
      readonly y: number;
      readonly radius: number;
      readonly filled: boolean;
      readonly strokeWidth: number;
    }
  | {
      readonly kind: "polyline";
      readonly points: readonly (readonly [number, number])[];
      readonly strokeWidth: number;
    };

const line = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  strokeWidth: number,
): PiecePatternPrimitive => ({ kind: "line", x1, y1, x2, y2, strokeWidth });
const rect = (
  x: number,
  y: number,
  width: number,
  height: number,
): PiecePatternPrimitive => ({ kind: "rect", x, y, width, height });
const circle = (
  x: number,
  y: number,
  radius: number,
  filled: boolean,
  strokeWidth = 0,
): PiecePatternPrimitive => ({ kind: "circle", x, y, radius, filled, strokeWidth });
const polyline = (
  points: readonly (readonly [number, number])[],
  strokeWidth: number,
): PiecePatternPrimitive => ({ kind: "polyline", points, strokeWidth });

const chevrons = (mirrored: boolean): readonly PiecePatternPrimitive[] =>
  [-20, 42, 104].map((x) => {
    const points = [[x, 22], [x + 30, 64], [x, 106]] as const;
    return polyline(
      mirrored
        ? points.map(([pointX, pointY]) => [128 - pointX, pointY] as const)
        : points,
      9,
    );
  });

/** Exact 128-unit pattern geometry shared by WebGL textures and DOM previews. */
export const PIECE_PATTERN_PRIMITIVES: Readonly<
  Record<PiecePattern, readonly PiecePatternPrimitive[]>
> = {
  diagonal: [-96, -42, 12, 66, 120].map((offset) =>
    line(offset, 128, offset + 128, 0, 12)
  ),
  vertical: [24, 64, 104].map((x) => rect(x - 6, 0, 12, 128)),
  horizontal: [24, 64, 104].map((y) => rect(0, y - 6, 128, 12)),
  dots: [24, 64, 104].flatMap((y) =>
    [24, 64, 104].map((x) => circle(x, y, 8, true))
  ),
  "chevron-left": chevrons(false),
  crosses: [32, 96].flatMap((y) =>
    [32, 96].flatMap((x) => [
      rect(x - 5, y - 16, 10, 32),
      rect(x - 16, y - 5, 32, 10),
    ])
  ),
  "chevron-right": chevrons(true),
  grid: Array.from({ length: 5 }, (_, index) => index * 32).flatMap((offset) => [
    line(offset, 0, offset, 128, 5),
    line(0, offset, 128, offset, 5),
  ]),
  cross: [
    line(64, 13, 64, 115, 13),
    line(13, 64, 115, 64, 13),
  ],
  circle: [circle(64, 64, 33, false, 11)],
  bubbles: [
    circle(32, 36, 12, false, 7),
    circle(86, 28, 8, false, 7),
    circle(76, 86, 16, false, 7),
    circle(26, 96, 6, false, 7),
  ],
};
