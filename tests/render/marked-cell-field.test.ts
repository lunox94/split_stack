import { describe, expect, it } from "vitest";

import {
  MARKED_CELL_FIELD_DURATION_MS,
  markedCellFieldEnvelopeAt,
  markedCellPresentationAt,
  resolveMarkedNeighborFields,
  type MarkedFieldCell,
} from "../../src/render/marked-cell-field";

const ordinaryCell = (
  column: number,
  row: number,
  role: MarkedFieldCell["role"] = "settled",
): MarkedFieldCell => ({ column, row, role });

const markedCell = (
  column: number,
  row: number,
  overrides: Partial<MarkedFieldCell> = {},
): MarkedFieldCell => ({
  column,
  row,
  role: "settled",
  special: "barrier",
  ...overrides,
});

describe("marked-cell synchronized field", () => {
  it("uses one repeating 2.8 second envelope for every marker", () => {
    expect(MARKED_CELL_FIELD_DURATION_MS).toBe(2_800);
    expect(markedCellFieldEnvelopeAt(0)).toBeCloseTo(0);
    expect(markedCellFieldEnvelopeAt(MARKED_CELL_FIELD_DURATION_MS / 2))
      .toBeCloseTo(1);
    expect(markedCellFieldEnvelopeAt(MARKED_CELL_FIELD_DURATION_MS)).toBeCloseTo(0);
    expect(
      markedCellFieldEnvelopeAt(MARKED_CELL_FIELD_DURATION_MS * 1.5),
    ).toBeCloseTo(1);
    expect(markedCellFieldEnvelopeAt(-MARKED_CELL_FIELD_DURATION_MS / 2))
      .toBeCloseTo(1);

    const timestampMs = 731;
    const barrier = markedCellPresentationAt(
      "barrier",
      "active",
      "full",
      timestampMs,
    );
    const blackout = markedCellPresentationAt(
      "blackout",
      "active",
      "full",
      timestampMs,
    );
    expect({ ...barrier, accent: 0 }).toEqual({ ...blackout, accent: 0 });
  });

  it("restores the source surface at the trough while keeping the glyph opaque", () => {
    const trough = markedCellPresentationAt(
      "column-bomb",
      "active",
      "full",
      0,
    );
    const peak = markedCellPresentationAt(
      "column-bomb",
      "active",
      "full",
      MARKED_CELL_FIELD_DURATION_MS / 2,
    );

    expect(trough.glyphOpacity).toBe(1);
    expect(peak.glyphOpacity).toBe(1);
    expect(trough.emissiveIntensity).toBe(0);
    expect(trough.sourceFaceOpacity).toBe(0);
    expect(trough.sourceRimOpacity).toBe(0);
    for (const key of [
      "emissiveIntensity",
      "sourceFaceOpacity",
      "sourceRimOpacity",
    ] as const) {
      expect(peak[key]).toBeGreaterThan(trough[key]);
      expect(peak[key]).toBeLessThanOrEqual(1);
    }
    expect(trough.neighborRimOpacity).toBeGreaterThan(0);
    expect(trough.neighborSurfaceOpacity).toBeGreaterThan(0);
  });

  it("makes the accessibility presentation invariant to time and transient emphasis", () => {
    const first = markedCellPresentationAt(
      "glitch-core",
      "settled",
      "limited",
      0,
      0,
      "spawn",
      true,
    );
    const later = markedCellPresentationAt(
      "glitch-core",
      "settled",
      "limited",
      MARKED_CELL_FIELD_DURATION_MS * 13 + 417,
      1,
      "lock",
      true,
    );

    expect(later).toEqual(first);
    expect(first.glyphOpacity).toBe(1);
    expect(first.sourceFaceOpacity).toBeGreaterThan(0);
    expect(first.neighborRimOpacity).toBeGreaterThan(0);
  });

  it("keeps quality degradation monotonic without reducing glyph opacity", () => {
    const timestampMs = MARKED_CELL_FIELD_DURATION_MS / 2;
    const full = markedCellPresentationAt(
      "garbage-core",
      "settled",
      "full",
      timestampMs,
    );
    const limited = markedCellPresentationAt(
      "garbage-core",
      "settled",
      "limited",
      timestampMs,
    );
    const reduced = markedCellPresentationAt(
      "garbage-core",
      "settled",
      "reduced",
      timestampMs,
    );

    expect([full.glyphOpacity, limited.glyphOpacity, reduced.glyphOpacity])
      .toEqual([1, 1, 1]);
    for (const key of [
      "sourceRimOpacity",
      "neighborRimOpacity",
      "neighborSurfaceOpacity",
    ] as const) {
      expect(full[key]).toBeGreaterThanOrEqual(limited[key]);
      expect(limited[key]).toBeGreaterThanOrEqual(reduced[key]);
    }
    expect(full.neighborRimOpacity).toBeGreaterThan(reduced.neighborRimOpacity);
    expect(full.neighborSurfaceOpacity).toBeGreaterThan(reduced.neighborSurfaceOpacity);
  });
});

describe("marked-cell neighbor field resolver", () => {
  it("keeps a separate contribution for every source-facing direction", () => {
    const fields = resolveMarkedNeighborFields([
      ordinaryCell(1, 1),
      markedCell(2, 1, { special: "column-bomb" }),
      markedCell(1, 2, { special: "blackout" }),
    ]).filter((field) => field.targetColumn === 1 && field.targetRow === 1);

    expect(fields.map((field) => ({
      special: field.sourceSpecial,
      direction: [field.directionX, field.directionY],
    }))).toEqual([
      { special: "column-bomb", direction: [1, 0] },
      { special: "blackout", direction: [0, 1] },
    ]);
  });

  it("resolves all eight occupied neighbors toward one marked source", () => {
    const source = markedCell(4, 4);
    const neighbors = [-1, 0, 1].flatMap((rowDelta) =>
      [-1, 0, 1]
        .filter((columnDelta) => columnDelta !== 0 || rowDelta !== 0)
        .map((columnDelta) => ordinaryCell(4 + columnDelta, 4 + rowDelta))
    );

    const fields = resolveMarkedNeighborFields([source, ...neighbors]);

    expect(fields.map((field) => ({
      target: [field.targetColumn, field.targetRow],
      direction: [field.directionX, field.directionY],
      attenuation: field.attenuation,
    }))).toEqual([
      { target: [3, 3], direction: [1, 1], attenuation: 1 },
      { target: [4, 3], direction: [0, 1], attenuation: 1 },
      { target: [5, 3], direction: [-1, 1], attenuation: 1 },
      { target: [3, 4], direction: [1, 0], attenuation: 1 },
      { target: [5, 4], direction: [-1, 0], attenuation: 1 },
      { target: [3, 5], direction: [1, -1], attenuation: 1 },
      { target: [4, 5], direction: [0, -1], attenuation: 1 },
      { target: [5, 5], direction: [-1, -1], attenuation: 1 },
    ]);
  });

  it("ignores empty and ghost cells as both targets and sources", () => {
    const fields = resolveMarkedNeighborFields([
      markedCell(4, 4),
      ordinaryCell(4, 3),
      ordinaryCell(3, 4, "ghost"),
      markedCell(5, 4, { role: "ghost", special: "blackout" }),
      ordinaryCell(6, 4),
    ]);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      sourceColumn: 4,
      sourceRow: 4,
      targetColumn: 4,
      targetRow: 3,
      directionX: 0,
      directionY: 1,
    });
  });

  it("keeps a marked target owned by its own hue instead of a foreign field", () => {
    const fields = resolveMarkedNeighborFields([
      markedCell(4, 4, { special: "barrier" }),
      markedCell(5, 4, { special: "blackout" }),
      ordinaryCell(6, 4),
    ]);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      sourceColumn: 5,
      sourceRow: 4,
      sourceSpecial: "blackout",
      targetColumn: 6,
      targetRow: 4,
      directionX: -1,
      directionY: 0,
    });
  });

  it("keeps every adjacent source-facing rim and surface stable", () => {
    const barrier = markedCell(1, 1, {
      role: "settled",
      special: "barrier",
    });
    const blackout = markedCell(2, 1, {
      role: "active",
      special: "blackout",
      specialEmphasis: 1,
    });
    const cells = [
      barrier,
      blackout,
      ordinaryCell(1, 2),
      ordinaryCell(2, 2),
    ];

    const forward = resolveMarkedNeighborFields(cells);
    const reversed = resolveMarkedNeighborFields([...cells].reverse());

    expect(forward).toEqual(reversed);
    expect(forward).toHaveLength(4);
    expect(new Set(forward.map((field) =>
      `${field.targetColumn}:${field.targetRow}:${field.directionX}:${field.directionY}`
    )).size).toBe(forward.length);
    expect(forward.map((field) => ({
      source: [field.sourceColumn, field.sourceRow, field.sourceSpecial],
      target: [field.targetColumn, field.targetRow],
      direction: [field.directionX, field.directionY],
      attenuation: field.attenuation,
    }))).toEqual([
      {
        source: [1, 1, "barrier"],
        target: [1, 2],
        direction: [0, -1],
        attenuation: 1,
      },
      {
        source: [2, 1, "blackout"],
        target: [1, 2],
        direction: [1, -1],
        attenuation: 1,
      },
      {
        source: [2, 1, "blackout"],
        target: [2, 2],
        direction: [0, -1],
        attenuation: 1,
      },
      {
        source: [1, 1, "barrier"],
        target: [2, 2],
        direction: [-1, -1],
        attenuation: 1,
      },
    ]);
    expect(forward.some((field) =>
      field.targetRow === 1 &&
      (field.targetColumn === 1 || field.targetColumn === 2)
    )).toBe(false);
  });

  it("keeps shared-neighbor directions stable as transient emphasis decays", () => {
    const fieldsAt = (rightEmphasis: number) => resolveMarkedNeighborFields([
      markedCell(0, 1, {
        role: "settled",
        special: "barrier",
      }),
      markedCell(2, 1, {
        role: "settled",
        special: "blackout",
        specialEmphasis: rightEmphasis,
        specialEmphasisKind: "spawn",
      }),
      ordinaryCell(1, 1),
    ]);
    const identity = (fields: ReturnType<typeof resolveMarkedNeighborFields>) =>
      fields.map((field) => ({
        source: [field.sourceColumn, field.sourceRow, field.sourceSpecial],
        target: [field.targetColumn, field.targetRow],
        direction: [field.directionX, field.directionY],
      }));

    const emphasized = fieldsAt(1);
    const decayed = fieldsAt(0);
    expect(emphasized).toHaveLength(2);
    expect(decayed).toHaveLength(2);
    expect(identity(emphasized)).toEqual(identity(decayed));
    expect(identity(decayed)).toEqual([
      {
        source: [0, 1, "barrier"],
        target: [1, 1],
        direction: [-1, 0],
      },
      {
        source: [2, 1, "blackout"],
        target: [1, 1],
        direction: [1, 0],
      },
    ]);
  });

  it("resolves only the three in-board neighbors of a corner source", () => {
    const fields = resolveMarkedNeighborFields([
      markedCell(0, 0),
      ordinaryCell(1, 0),
      ordinaryCell(0, 1),
      ordinaryCell(1, 1),
    ]);

    expect(fields.map((field) => ({
      target: [field.targetColumn, field.targetRow],
      direction: [field.directionX, field.directionY],
    }))).toEqual([
      { target: [1, 0], direction: [-1, 0] },
      { target: [0, 1], direction: [0, -1] },
      { target: [1, 1], direction: [-1, -1] },
    ]);
  });

  it("resolves directional overlaps independent of input order", () => {
    const target = ordinaryCell(2, 2);
    const candidates = [
      markedCell(2, 1, {
        role: "settled",
        special: "barrier",
        specialEmphasis: 1,
      }),
      markedCell(1, 2, {
        role: "active",
        special: "blackout",
        specialEmphasis: 0.1,
      }),
      markedCell(1, 1, {
        role: "active",
        special: "column-bomb",
        specialEmphasis: 1,
      }),
    ];

    const forward = resolveMarkedNeighborFields([...candidates, target]);
    const reversed = resolveMarkedNeighborFields([target, ...[...candidates].reverse()]);

    expect(forward).toEqual(reversed);
    expect(forward).toHaveLength(3);
    expect(new Set(forward.map((field) =>
      `${field.directionX}:${field.directionY}`
    ))).toEqual(new Set(["-1:0", "0:-1", "-1:-1"]));
  });
});
