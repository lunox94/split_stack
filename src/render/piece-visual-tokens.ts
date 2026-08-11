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
