// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  SPECIAL_ACCENT_COLORS,
  SPECIAL_ACCENT_HEX,
  SPECIAL_ICON_PATHS,
  createSpecialIcon,
} from "../../src/render/special-icons";
import type { SpecialKind } from "../../src/domain/types";

const SPECIALS: readonly SpecialKind[] = [
  "column-bomb",
  "garbage-core",
  "glitch-core",
  "blackout",
  "barrier",
];

describe("canonical marked-power presentation", () => {
  it("publishes one distinct accent for every marked power", () => {
    expect(SPECIALS.map((special) => SPECIAL_ACCENT_COLORS[special])).toEqual([
      "#ffb33f",
      "#ff6f61",
      "#b7ff3c",
      "#9b7bff",
      "#57e6ff",
    ]);
    expect(new Set(SPECIALS.map((special) => SPECIAL_ACCENT_HEX[special])).size)
      .toBe(SPECIALS.length);
    for (const special of SPECIALS) {
      expect(Number.parseInt(SPECIAL_ACCENT_COLORS[special].slice(1), 16))
        .toBe(SPECIAL_ACCENT_HEX[special]);
    }
  });

  it("uses the same canonical path and accent when creating guide icons", () => {
    for (const special of SPECIALS) {
      const icon = createSpecialIcon(document, special, special);
      expect(icon.querySelector("path")?.getAttribute("d"))
        .toBe(SPECIAL_ICON_PATHS[special]);
      expect(icon.style.getPropertyValue("--special-accent"))
        .toBe(SPECIAL_ACCENT_COLORS[special]);
      expect(icon.getAttribute("viewBox")).toBe("0 0 64 64");
    }
  });

  it("keeps Blackout and Barrier recognizable without relying on color", () => {
    expect(SPECIAL_ICON_PATHS.blackout).toContain("M12 31");
    expect(SPECIAL_ICON_PATHS.blackout).toContain("M15 49");
    expect(SPECIAL_ICON_PATHS.barrier).toContain("M32 7");
    expect(SPECIAL_ICON_PATHS.barrier).toContain("M32 17");
  });
});
