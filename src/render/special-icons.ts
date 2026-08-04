import type { SpecialKind } from "../domain/types";

export const SPECIAL_ICON_PATHS: Readonly<Record<SpecialKind, string>> = {
  "column-bomb":
    "M32 8v31m-9-9 9 9 9-9M32 44a7 7 0 1 0 0 14 7 7 0 1 0 0-14z",
  "garbage-core": "M14 14h36v36H14zM14 32h36M32 14v36",
  "glitch-core": "M12 18h15l-8 12h17l-9 16h25M44 13l8 8-8 8",
  blackout:
    "M12 31c6-9 13-13 20-13s14 4 20 13c-6 9-13 13-20 13S18 40 12 31zM25 31a7 7 0 1 0 14 0 7 7 0 1 0-14 0M15 49 49 15",
  barrier: "M32 7 50 14v16c0 12-7 21-18 27C21 51 14 42 14 30V14zM32 17v31",
};

export const SPECIAL_ACCENT_COLORS: Readonly<Record<SpecialKind, string>> = {
  "column-bomb": "#ffb33f",
  "garbage-core": "#ff6f61",
  "glitch-core": "#b7ff3c",
  blackout: "#9b7bff",
  barrier: "#57e6ff",
};

export const SPECIAL_ACCENT_HEX: Readonly<Record<SpecialKind, number>> = {
  "column-bomb": 0xffb33f,
  "garbage-core": 0xff6f61,
  "glitch-core": 0xb7ff3c,
  blackout: 0x9b7bff,
  barrier: 0x57e6ff,
};

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export function createSpecialIcon(
  document: Document,
  special: SpecialKind,
  label: string,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.dataset.specialIcon = special;
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("focusable", "false");
  svg.style.color = SPECIAL_ACCENT_COLORS[special];
  svg.style.setProperty("--special-accent", SPECIAL_ACCENT_COLORS[special]);
  const path = document.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute("d", SPECIAL_ICON_PATHS[special]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}
