import { describe, expect, it } from "vitest";

import {
  COLORBLIND_PIECE_COLORS,
  PIECE_PATTERNS,
  STANDARD_PIECE_COLORS,
} from "../../src/render/piece-visual-tokens";

describe("piece visual tokens", () => {
  it("provides one shared palette and pattern identity for every rendered cell kind", () => {
    expect(STANDARD_PIECE_COLORS).toMatchObject({
      I: "#2bd9fe",
      T: "#b65cff",
      cross: "#f5ff72",
      "small-cross": "#dc143c",
      garbage: "#768094",
      acid: "#8dff5a",
    });
    expect(COLORBLIND_PIECE_COLORS).toMatchObject({
      I: "#56b4e9",
      T: "#cc79a7",
      cross: "#ffffff",
      "small-cross": "#ffffff",
      garbage: "#777777",
      acid: "#8cff00",
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
