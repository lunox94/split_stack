import { getDescriptorCells, getPieceCellKind } from "../domain/pieces";
import type {
  FallingShape,
  PieceDescriptor,
  SpecialKind,
  StandardShape,
} from "../domain/types";
import { STRINGS } from "../app/strings";
import {
  createSpecialIcon,
  SPECIAL_ACCENT_COLORS,
} from "../render/special-icons";
import {
  COLORBLIND_PIECE_COLORS,
  PIECE_PATTERN_PRIMITIVES,
  PIECE_PATTERNS,
  STANDARD_PIECE_COLORS,
  type PiecePattern,
  type PieceVisualKind,
} from "../render/piece-visual-tokens";

export interface PiecePreviewOptions {
  readonly colorPalette: "standard" | "colorblind";
  readonly reducedMotion: boolean;
  readonly reducedFlashes: boolean;
  readonly elapsedMs: number;
}

const SPECIAL_LABELS: Readonly<Record<SpecialKind, string>> = {
  "column-bomb": STRINGS["special.columnBomb"],
  "garbage-core": STRINGS["special.garbageCore"],
  "glitch-core": STRINGS["special.glitchCore"],
  blackout: STRINGS["power.blackout"],
  barrier: STRINGS["power.barrier"],
};

const STATIC_GLITCH_CELLS = [
  { x: 0, y: 0, index: 0, shape: "I" },
  { x: 2, y: 0, index: 1, shape: "J" },
  { x: 1, y: 1, index: 2, shape: "T" },
  { x: 0, y: 2, index: 3, shape: "S" },
  { x: 2, y: 2, index: 4, shape: "Z" },
] as const satisfies ReadonlyArray<{
  readonly x: number;
  readonly y: number;
  readonly index: number;
  readonly shape: StandardShape;
}>;

const SLOT_SIGNATURES = new WeakMap<HTMLElement, string>();
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function createPiecePattern(
  document: Document,
  pattern: PiecePattern,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.classList.add("piece-preview-pattern");
  svg.dataset.piecePattern = pattern;
  svg.setAttribute("viewBox", "0 0 128 128");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const primitive of PIECE_PATTERN_PRIMITIVES[pattern]) {
    if (primitive.kind === "rect") {
      const rect = document.createElementNS(SVG_NAMESPACE, "rect");
      rect.setAttribute("x", String(primitive.x));
      rect.setAttribute("y", String(primitive.y));
      rect.setAttribute("width", String(primitive.width));
      rect.setAttribute("height", String(primitive.height));
      rect.setAttribute("fill", "currentColor");
      svg.append(rect);
      continue;
    }
    if (primitive.kind === "circle") {
      const circle = document.createElementNS(SVG_NAMESPACE, "circle");
      circle.setAttribute("cx", String(primitive.x));
      circle.setAttribute("cy", String(primitive.y));
      circle.setAttribute("r", String(primitive.radius));
      circle.setAttribute("fill", primitive.filled ? "currentColor" : "none");
      if (!primitive.filled) {
        circle.setAttribute("stroke", "currentColor");
        circle.setAttribute("stroke-width", String(primitive.strokeWidth));
      }
      svg.append(circle);
      continue;
    }
    const stroke = primitive.kind === "line"
      ? document.createElementNS(SVG_NAMESPACE, "line")
      : document.createElementNS(SVG_NAMESPACE, "polyline");
    if (primitive.kind === "line") {
      stroke.setAttribute("x1", String(primitive.x1));
      stroke.setAttribute("y1", String(primitive.y1));
      stroke.setAttribute("x2", String(primitive.x2));
      stroke.setAttribute("y2", String(primitive.y2));
    } else {
      stroke.setAttribute(
        "points",
        primitive.points.map(([x, y]) => `${x},${y}`).join(" "),
      );
    }
    stroke.setAttribute("fill", "none");
    stroke.setAttribute("stroke", "currentColor");
    stroke.setAttribute("stroke-width", String(primitive.strokeWidth));
    stroke.setAttribute("stroke-linecap", "round");
    stroke.setAttribute("stroke-linejoin", "round");
    svg.append(stroke);
  }
  return svg;
}

function displayedGlitchShape(
  descriptor: PieceDescriptor,
  elapsedMs: number,
): StandardShape | null {
  const cosmetics = descriptor.previewCosmetics;
  if (
    cosmetics === undefined ||
    cosmetics.shapes.length === 0 ||
    !Number.isFinite(elapsedMs) ||
    cosmetics.intervalMs <= 0
  ) {
    return null;
  }
  const index = Math.floor(Math.max(0, elapsedMs) / cosmetics.intervalMs) %
    cosmetics.shapes.length;
  return cosmetics.shapes[index] ?? null;
}

function pieceLabel(descriptor: PieceDescriptor, concealed: boolean): string {
  const base = descriptor.source === "cross"
    ? "Hollow Cross"
    : descriptor.source === "oversize"
      ? `Oversize ${descriptor.shape}`
      : descriptor.source === "glitch" || descriptor.previewCosmetics !== undefined
        ? concealed ? "Glitch Piece, shape concealed" : `Glitch Piece ${descriptor.shape}`
        : descriptor.shape;
  return descriptor.specialKind === undefined
    ? base
    : `${base} with ${SPECIAL_LABELS[descriptor.specialKind]}`;
}

function appendCell(
  document: Document,
  grid: HTMLElement,
  cell: { readonly x: number; readonly y: number; readonly index: number },
  shape: PieceVisualKind,
  descriptor: PieceDescriptor,
  minX: number,
  minY: number,
  palette: PiecePreviewOptions["colorPalette"],
): void {
  const node = document.createElement("span");
  node.className = "piece-preview-cell";
  node.dataset.shape = shape;
  node.dataset.pattern = PIECE_PATTERNS[shape];
  node.dataset.palette = palette;
  node.style.gridColumn = String(cell.x - minX + 1);
  node.style.gridRow = String(cell.y - minY + 1);
  node.style.setProperty(
    "--piece-color",
    (palette === "colorblind"
      ? COLORBLIND_PIECE_COLORS
      : STANDARD_PIECE_COLORS)[shape],
  );
  node.append(createPiecePattern(document, PIECE_PATTERNS[shape]));
  if (
    cell.index === descriptor.specialCellIndex &&
    descriptor.specialKind !== undefined
  ) {
    node.classList.add("is-marked");
    node.dataset.special = descriptor.specialKind;
    node.style.setProperty(
      "--piece-color",
      SPECIAL_ACCENT_COLORS[descriptor.specialKind],
    );
    node.style.setProperty(
      "--special-accent",
      SPECIAL_ACCENT_COLORS[descriptor.specialKind],
    );
    const icon = createSpecialIcon(
      document,
      descriptor.specialKind,
      SPECIAL_LABELS[descriptor.specialKind],
    );
    const glyphStroke = icon.querySelector<SVGPathElement>("path");
    if (glyphStroke !== null) {
      const glyphUnderstroke = glyphStroke.cloneNode(true) as SVGPathElement;
      glyphUnderstroke.classList.add("glyph-understroke");
      glyphStroke.classList.add("glyph-stroke");
      icon.insertBefore(glyphUnderstroke, glyphStroke);
    }
    node.append(icon);
  }
  grid.append(node);
}

export function renderPiecePreviewSlot(
  slot: HTMLElement,
  descriptor: PieceDescriptor | null,
  options: PiecePreviewOptions,
): void {
  const document = slot.ownerDocument;
  const glitchShape = descriptor === null
    ? null
    : displayedGlitchShape(descriptor, options.elapsedMs);
  const staticGlitch = descriptor?.previewCosmetics !== undefined &&
    (options.reducedMotion || options.reducedFlashes);
  const signature = descriptor === null
    ? "empty"
    : [
        descriptor.source,
        descriptor.shape,
        descriptor.specialCellIndex ?? "",
        descriptor.specialKind ?? "",
        descriptor.crossVariant ?? "",
        descriptor.previewCosmetics?.kind ?? "stable",
        staticGlitch ? "static" : glitchShape ?? descriptor.shape,
        options.colorPalette,
      ].join(":");
  if (SLOT_SIGNATURES.get(slot) === signature) return;
  SLOT_SIGNATURES.set(slot, signature);
  slot.replaceChildren();
  delete slot.dataset.source;
  delete slot.dataset.displayShape;
  delete slot.dataset.glitch;
  slot.classList.toggle("is-empty", descriptor === null);
  if (descriptor === null) {
    const empty = document.createElement("span");
    empty.className = "piece-preview-empty";
    empty.textContent = "—";
    slot.setAttribute("aria-label", "Empty piece slot");
    slot.append(empty);
    return;
  }

  slot.dataset.source = descriptor.source;
  const concealed = descriptor.previewCosmetics?.finalShapeConcealed === true;
  const grid = document.createElement("span");
  grid.className = "piece-preview-grid";
  grid.setAttribute("aria-hidden", "true");

  if (staticGlitch) {
    slot.dataset.glitch = "static";
    slot.dataset.displayShape = "concealed";
    grid.style.setProperty("--preview-columns", "3");
    grid.style.setProperty("--preview-rows", "3");
    for (const cell of STATIC_GLITCH_CELLS) {
      appendCell(document, grid, cell, cell.shape, descriptor, 0, 0, options.colorPalette);
    }
  } else {
    const displayShape = glitchShape ?? descriptor.shape;
    const displayedDescriptor: PieceDescriptor = descriptor.source === "glitch"
      ? { ...descriptor, shape: displayShape as StandardShape }
      : descriptor;
    const cells = getDescriptorCells(displayedDescriptor, 0);
    const minX = Math.min(...cells.map((cell) => cell.x));
    const maxX = Math.max(...cells.map((cell) => cell.x));
    const minY = Math.min(...cells.map((cell) => cell.y));
    const maxY = Math.max(...cells.map((cell) => cell.y));
    grid.style.setProperty("--preview-columns", String(maxX - minX + 1));
    grid.style.setProperty("--preview-rows", String(maxY - minY + 1));
    slot.dataset.displayShape = displayShape;
    if (glitchShape !== null) slot.dataset.glitch = "cycling";
    for (const cell of cells) {
      appendCell(
        document,
        grid,
        cell,
        displayedDescriptor.shape === "acid"
          ? "acid"
          : getPieceCellKind(displayedDescriptor, cell.index),
        descriptor,
        minX,
        minY,
        options.colorPalette,
      );
    }
  }

  slot.setAttribute("aria-label", pieceLabel(descriptor, concealed));
  slot.append(grid);
}
