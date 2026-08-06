import type { PowerKind } from "../domain/types";

export const POWER_ICON_PATHS: Readonly<Record<PowerKind, string>> = {
  scramble:
    "M10 18h10c10 0 12 28 24 28h10M46 38l8 8-8 8M10 46h10c10 0 12-28 24-28h10M46 10l8 8-8 8",
  nuke:
    "M32 9v8M32 47v8M9 32h8M47 32h8M15 15l6 6M43 43l6 6M49 15l-6 6M21 43l-6 6M24 32a8 8 0 1 0 16 0 8 8 0 1 0-16 0",
  collapse:
    "M16 10v30m-8-8 8 8 8-8M32 10v30m-8-8 8 8 8-8M48 10v30m-8-8 8 8 8-8M9 52h46",
  "monomino-rush": "M30 22h22v22H30zM9 16h16M13 26h12M9 36h16M14 46h11",
  "acid-rain":
    "M13 25c0-7 5-12 12-12 3-5 9-7 14-4 5 0 9 3 10 8 5 1 8 5 8 10 0 6-5 10-11 10H21c-7 0-12-4-12-10 0-5 2-8 4-10zM21 42c0 0-4 5-4 8a4 4 0 0 0 8 0c0-3-4-8-4-8zM39 42c0 0-4 5-4 8a4 4 0 0 0 8 0c0-3-4-8-4-8z",
  oversize:
    "M24 24 12 12M12 12h10M12 12v10M40 24l12-12M52 12H42M52 12v10M24 40 12 52M12 52h10M12 52V42M40 40l12 12M52 52H42M52 52V42M24 24h16v16H24z",
  "ghost-jam":
    "M16 49V29c0-11 7-19 16-19s16 8 16 19v20l-8-5-8 5-8-5zM25 28h1M38 28h1M24 37c5 4 11 4 16 0M12 12l40 40",
};

export const POWER_ACCENT_COLORS: Readonly<Record<PowerKind, string>> = {
  scramble: "#ff8ade",
  nuke: "#ff665e",
  collapse: "#ffd84a",
  "monomino-rush": "#77e65c",
  "acid-rain": "#42e8ba",
  oversize: "#4dbdff",
  "ghost-jam": "#ad8cff",
};

export const POWER_ACCENT_HEX: Readonly<Record<PowerKind, number>> = {
  scramble: 0xff8ade,
  nuke: 0xff665e,
  collapse: 0xffd84a,
  "monomino-rush": 0x77e65c,
  "acid-rain": 0x42e8ba,
  oversize: 0x4dbdff,
  "ghost-jam": 0xad8cff,
};

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export function createPowerIcon(
  document: Document,
  power: PowerKind,
  label: string,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.dataset.powerIcon = power;
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("focusable", "false");
  svg.style.color = POWER_ACCENT_COLORS[power];
  svg.style.setProperty("--power-accent", POWER_ACCENT_COLORS[power]);

  const path = document.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute("d", POWER_ICON_PATHS[power]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}
