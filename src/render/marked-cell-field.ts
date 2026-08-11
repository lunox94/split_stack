import type { SpecialKind } from "../domain/types";
import { SPECIAL_ACCENT_HEX } from "./special-icons";
import type { EffectQuality } from "./quality";

export type MarkedFieldRole = "settled" | "active" | "ghost";

export interface MarkedFieldCell {
  readonly column: number;
  readonly row: number;
  readonly role: MarkedFieldRole;
  readonly special?: SpecialKind;
  readonly specialEmphasis?: number;
  readonly specialEmphasisKind?: "spawn" | "lock";
}

export interface MarkedCellPresentation {
  readonly accent: number;
  readonly emissiveIntensity: number;
  readonly glyphOpacity: number;
  readonly sourceFaceOpacity: number;
  readonly sourceRimOpacity: number;
  readonly neighborRimOpacity: number;
  readonly neighborSurfaceOpacity: number;
}

export interface MarkedNeighborField {
  readonly sourceColumn: number;
  readonly sourceRow: number;
  readonly sourceRole: Exclude<MarkedFieldRole, "ghost">;
  readonly sourceSpecial: SpecialKind;
  readonly sourceEmphasis: number;
  readonly sourceEmphasisKind: "spawn" | "lock";
  readonly targetColumn: number;
  readonly targetRow: number;
  /** Direction from the illuminated target toward its marked source. */
  readonly directionX: -1 | 0 | 1;
  /** Direction from the illuminated target toward its marked source. */
  readonly directionY: -1 | 0 | 1;
  /** Reserved for the renderer intensity seam; deterministic winners are 1. */
  readonly attenuation: number;
}

export const MARKED_CELL_FIELD_DURATION_MS = 2_800;

export function markedCellFieldEnvelopeAt(timestampMs: number): number {
  const elapsed = timestampMs % MARKED_CELL_FIELD_DURATION_MS;
  const phase = (elapsed < 0 ? elapsed + MARKED_CELL_FIELD_DURATION_MS : elapsed) /
    MARKED_CELL_FIELD_DURATION_MS;
  const cosine = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  return cosine * cosine * (3 - 2 * cosine);
}

export function markedCellPresentationAt(
  special: SpecialKind,
  role: MarkedFieldRole,
  quality: EffectQuality,
  timestampMs: number,
  emphasis = 0,
  emphasisKind: "spawn" | "lock" = "spawn",
  staticPresentation = false,
): MarkedCellPresentation {
  const field = staticPresentation ? 0.72 : markedCellFieldEnvelopeAt(timestampMs);
  const pulse = staticPresentation ? 0 : Math.max(0, Math.min(1, emphasis));
  const spawn = emphasisKind === "spawn" ? pulse : 0;
  const lock = emphasisKind === "lock" ? pulse : 0;
  const ghost = role === "ghost";
  const roleStrength = role === "active" ? 1 : role === "settled" ? 0.9 : 0.24;
  const rimQuality = quality === "full" ? 1 : quality === "limited" ? 0.84 : 0.62;
  const surfaceQuality = quality === "full" ? 1 : quality === "limited" ? 0.58 : 0;

  if (ghost) {
    return {
      accent: SPECIAL_ACCENT_HEX[special],
      emissiveIntensity: 0,
      glyphOpacity: 0.3,
      sourceFaceOpacity: 0,
      sourceRimOpacity: 0,
      neighborRimOpacity: 0,
      neighborSurfaceOpacity: 0,
    };
  }

  return {
    accent: SPECIAL_ACCENT_HEX[special],
    // The synchronized field adds no light at its trough: the source then uses
    // its unlit power-accent surface beneath the always-opaque glyph.
    emissiveIntensity: field * 0.078 * roleStrength,
    glyphOpacity: 1,
    sourceFaceOpacity: Math.min(
      0.28,
      field * 0.09 * roleStrength + spawn * 0.07 + lock * 0.025,
    ),
    sourceRimOpacity: Math.min(
      0.72,
      (field * 0.45 * roleStrength + spawn * 0.08 + lock * 0.03) *
        rimQuality,
    ),
    neighborRimOpacity: Math.min(
      1,
      (0.06 + field * 0.92) * roleStrength * rimQuality,
    ),
    neighborSurfaceOpacity: Math.min(
      1,
      (0.03 + field * 0.84) * roleStrength * surfaceQuality,
    ),
  };
}

type UnresolvedNeighborField = Omit<MarkedNeighborField, "attenuation">;

function fieldWinnerOrder(
  left: UnresolvedNeighborField,
  right: UnresolvedNeighborField,
): number {
  const leftDistance = Math.abs(left.directionX) + Math.abs(left.directionY);
  const rightDistance = Math.abs(right.directionX) + Math.abs(right.directionY);
  return leftDistance - rightDistance ||
    Number(right.sourceRole === "active") - Number(left.sourceRole === "active") ||
    left.sourceRow - right.sourceRow ||
    left.sourceColumn - right.sourceColumn ||
    left.sourceSpecial.localeCompare(right.sourceSpecial);
}

export function resolveMarkedNeighborFields(
  cells: readonly MarkedFieldCell[],
): readonly MarkedNeighborField[] {
  const occupied = new Map<string, MarkedFieldCell>();
  const canonicalCells = cells
    .filter((cell) => cell.role !== "ghost")
    .slice()
    .sort((left, right) =>
      left.row - right.row ||
      left.column - right.column ||
      Number(right.special !== undefined) - Number(left.special !== undefined) ||
      (left.special ?? "").localeCompare(right.special ?? "") ||
      left.role.localeCompare(right.role)
    );
  for (const cell of canonicalCells) {
    const key = `${cell.column}:${cell.row}`;
    if (!occupied.has(key)) occupied.set(key, cell);
  }

  const sources = canonicalCells
    .filter(
      (cell): cell is MarkedFieldCell & {
        readonly special: SpecialKind;
        readonly role: "active" | "settled";
      } => cell.special !== undefined && cell.role !== "ghost",
    )
    .slice()
    .sort((left, right) =>
      left.row - right.row ||
      left.column - right.column ||
      left.special.localeCompare(right.special) ||
      left.role.localeCompare(right.role)
    );

  const winners = new Map<string, UnresolvedNeighborField>();
  for (const source of sources) {
    for (let rowDelta = -1; rowDelta <= 1; rowDelta += 1) {
      for (let columnDelta = -1; columnDelta <= 1; columnDelta += 1) {
        if (columnDelta === 0 && rowDelta === 0) continue;
        const targetColumn = source.column + columnDelta;
        const targetRow = source.row + rowDelta;
        const targetKey = `${targetColumn}:${targetRow}`;
        const target = occupied.get(targetKey);
        // A marked cell owns its source treatment and hue. Foreign fields only
        // compete for ordinary occupied cells.
        if (target === undefined || target.special !== undefined) continue;
        const directionX = columnDelta === 0 ? 0 : columnDelta > 0 ? -1 : 1;
        const directionY = rowDelta === 0 ? 0 : rowDelta > 0 ? -1 : 1;
        const candidate: UnresolvedNeighborField = {
          sourceColumn: source.column,
          sourceRow: source.row,
          sourceRole: source.role,
          sourceSpecial: source.special,
          sourceEmphasis: source.specialEmphasis ?? 0,
          sourceEmphasisKind: source.specialEmphasisKind ?? "spawn",
          targetColumn,
          targetRow,
          directionX,
          directionY,
        };
        // Keep one deterministic contribution per facing direction. A cell
        // beside two sources must light both corresponding rim sections.
        const directionalTargetKey =
          `${targetKey}:${directionX}:${directionY}`;
        const winner = winners.get(directionalTargetKey);
        if (winner === undefined || fieldWinnerOrder(candidate, winner) < 0) {
          winners.set(directionalTargetKey, candidate);
        }
      }
    }
  }

  return [...winners.values()]
    .sort((left, right) =>
      left.targetRow - right.targetRow ||
      left.targetColumn - right.targetColumn ||
      fieldWinnerOrder(left, right)
    )
    .map((field) => ({ ...field, attenuation: 1 }));
}
