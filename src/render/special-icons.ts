import type { SpecialKind } from "../domain/types";

export const SPECIAL_ICON_PATHS: Readonly<Record<SpecialKind, string>> = {
  "column-bomb":
    "M32 8v31m-9-9 9 9 9-9M32 44a7 7 0 1 0 0 14 7 7 0 1 0 0-14z",
  "garbage-core": "M14 14h36v36H14zM14 32h36M32 14v36",
  "glitch-core": "M12 18h15l-8 12h17l-9 16h25M44 13l8 8-8 8",
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
