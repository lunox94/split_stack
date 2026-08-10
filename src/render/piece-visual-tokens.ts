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
  I: "#2bd9fe",
  J: "#3975ff",
  L: "#ff9029",
  O: "#ffd83d",
  S: "#43dc78",
  T: "#b65cff",
  Z: "#ff4f62",
  cross: "#f5ff72",
  "small-cross": "#dc143c",
  monomino: "#f2f6ff",
  garbage: "#768094",
  acid: "#8dff5a",
} as const satisfies Readonly<Record<PieceVisualKind, string>>;

export const COLORBLIND_PIECE_COLORS = {
  I: "#56b4e9",
  J: "#0072b2",
  L: "#e69f00",
  O: "#f0e442",
  S: "#009e73",
  T: "#cc79a7",
  Z: "#d55e00",
  cross: "#ffffff",
  "small-cross": "#ffffff",
  monomino: "#bde8ff",
  garbage: "#777777",
  acid: "#8cff00",
} as const satisfies Readonly<Record<PieceVisualKind, string>>;

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
