import { getDescriptorCells } from "../domain/pieces";
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
  PIECE_PATTERNS,
  STANDARD_PIECE_COLORS,
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
  shape: FallingShape,
  descriptor: PieceDescriptor,
  minX: number,
  minY: number,
  palette: PiecePreviewOptions["colorPalette"],
): void {
  const node = document.createElement("span");
  node.className = "piece-preview-cell";
  node.dataset.shape = shape;
  node.dataset.pattern = PIECE_PATTERNS[shape];
  node.style.gridColumn = String(cell.x - minX + 1);
  node.style.gridRow = String(cell.y - minY + 1);
  node.style.setProperty(
    "--piece-color",
    (palette === "colorblind"
      ? COLORBLIND_PIECE_COLORS
      : STANDARD_PIECE_COLORS)[shape],
  );
  if (
    cell.index === descriptor.specialCellIndex &&
    descriptor.specialKind !== undefined
  ) {
    node.classList.add("is-marked");
    node.dataset.special = descriptor.specialKind;
    node.style.setProperty(
      "--special-accent",
      SPECIAL_ACCENT_COLORS[descriptor.specialKind],
    );
    node.append(
      createSpecialIcon(
        document,
        descriptor.specialKind,
        SPECIAL_LABELS[descriptor.specialKind],
      ),
    );
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
    const displayedDescriptor: PieceDescriptor = {
      ...descriptor,
      shape: displayShape,
    };
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
        displayShape,
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

export function createMarkedCellSample(
  document: Document,
  special: SpecialKind,
  palette: PiecePreviewOptions["colorPalette"] = "standard",
): HTMLElement {
  const sample = document.createElement("span");
  sample.className = "marked-cell-sample";
  sample.dataset.special = special;
  const descriptor: PieceDescriptor = {
    source: "base",
    shape: "O",
    specialCellIndex: 0,
    specialKind: special,
  };
  appendCell(document, sample, { x: 0, y: 0, index: 0 }, "O", descriptor, 0, 0, palette);
  sample.setAttribute("aria-label", `${SPECIAL_LABELS[special]} marked cell`);
  return sample;
}
