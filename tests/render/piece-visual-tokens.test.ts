import { describe, expect, it } from "vitest";

import {
  COLORBLIND_PIECE_COLORS,
  PIECE_PATTERNS,
  STANDARD_PIECE_COLORS,
} from "../../src/render/piece-visual-tokens";

describe("piece visual tokens", () => {
  it("provides one shared palette and pattern identity for every rendered cell kind", () => {
    expect(STANDARD_PIECE_COLORS).toMatchObject({
      I: "#20c8ee",
      T: "#b95eeb",
      cross: "#effb76",
      "small-cross": "#df5065",
      garbage: "#737d90",
      acid: "#82ed50",
    });
    expect(COLORBLIND_PIECE_COLORS).toMatchObject({
      I: "#4caddd",
      T: "#c873a4",
      cross: "#ffffff",
      "small-cross": "#f8f8ff",
      garbage: "#787878",
      acid: "#7fe51f",
    });
    expect(PIECE_PATTERNS).toMatchObject({
      I: "diagonal",
      T: "crosses",
      cross: "cross",
      "small-cross": "cross",
      garbage: "grid",
      acid: "bubbles",
    });
    expect(Object.keys(STANDARD_PIECE_COLORS).sort())
      .toEqual(Object.keys(PIECE_PATTERNS).sort());
  });
});
