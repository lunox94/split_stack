// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  POWER_ACCENT_COLORS,
  POWER_ACCENT_HEX,
  POWER_ICON_PATHS,
  createPowerIcon,
} from "../../src/render/power-icons";
import type { PowerKind } from "../../src/domain/types";

const POWERS: readonly PowerKind[] = [
  "scramble",
  "nuke",
  "collapse",
  "monomino-rush",
  "acid-rain",
  "oversize",
  "ghost-jam",
];

describe("canonical meter-power presentation", () => {
  it("publishes one stable, distinct accent for every meter power", () => {
    expect(POWERS.map((power) => POWER_ACCENT_COLORS[power])).toEqual([
      "#ff8ade",
      "#ff665e",
      "#ffd84a",
      "#f2f6ff",
      "#42e8ba",
      "#4dbdff",
      "#ad8cff",
    ]);
    expect(new Set(POWERS.map((power) => POWER_ACCENT_HEX[power])).size).toBe(
      POWERS.length,
    );
    for (const power of POWERS) {
      expect(Number.parseInt(POWER_ACCENT_COLORS[power].slice(1), 16)).toBe(
        POWER_ACCENT_HEX[power],
      );
    }
  });

  it("publishes one stable, distinct glyph for every meter power", () => {
    expect(POWERS.map((power) => POWER_ICON_PATHS[power])).toEqual([
      "M10 18h10c10 0 12 28 24 28h10M46 38l8 8-8 8M10 46h10c10 0 12-28 24-28h10M46 10l8 8-8 8",
      "M32 9v8M32 47v8M9 32h8M47 32h8M15 15l6 6M43 43l6 6M49 15l-6 6M21 43l-6 6M24 32a8 8 0 1 0 16 0 8 8 0 1 0-16 0",
      "M16 10v30m-8-8 8 8 8-8M32 10v30m-8-8 8 8 8-8M48 10v30m-8-8 8 8 8-8M9 52h46",
      "M30 22h22v22H30zM9 16h16M13 26h12M9 36h16M14 46h11",
      "M13 25c0-7 5-12 12-12 3-5 9-7 14-4 5 0 9 3 10 8 5 1 8 5 8 10 0 6-5 10-11 10H21c-7 0-12-4-12-10 0-5 2-8 4-10zM21 42c0 0-4 5-4 8a4 4 0 0 0 8 0c0-3-4-8-4-8zM39 42c0 0-4 5-4 8a4 4 0 0 0 8 0c0-3-4-8-4-8z",
      "M24 24 12 12M12 12h10M12 12v10M40 24l12-12M52 12H42M52 12v10M24 40 12 52M12 52h10M12 52V42M40 40l12 12M52 52H42M52 52V42M24 24h16v16H24z",
      "M16 49V29c0-11 7-19 16-19s16 8 16 19v20l-8-5-8 5-8-5zM25 28h1M38 28h1M24 37c5 4 11 4 16 0M12 12l40 40",
    ]);
    expect(new Set(POWERS.map((power) => POWER_ICON_PATHS[power])).size).toBe(
      POWERS.length,
    );
  });

  it("creates accessible current-color SVG icons from the canonical tokens", () => {
    for (const power of POWERS) {
      const label = `Upcoming power: ${power}`;
      const icon = createPowerIcon(document, power, label);
      const path = icon.querySelector("path");

      expect(icon.dataset.powerIcon).toBe(power);
      expect(icon.getAttribute("viewBox")).toBe("0 0 64 64");
      expect(icon.getAttribute("role")).toBe("img");
      expect(icon.getAttribute("aria-label")).toBe(label);
      expect(icon.getAttribute("focusable")).toBe("false");
      expect(icon.style.getPropertyValue("--power-accent")).toBe(
        POWER_ACCENT_COLORS[power],
      );
      expect(path?.getAttribute("d")).toBe(POWER_ICON_PATHS[power]);
      expect(path?.getAttribute("fill")).toBe("none");
      expect(path?.getAttribute("stroke")).toBe("currentColor");
      expect(path?.getAttribute("stroke-width")).toBe("5");
      expect(path?.getAttribute("stroke-linecap")).toBe("round");
      expect(path?.getAttribute("stroke-linejoin")).toBe("round");
    }
  });
});
