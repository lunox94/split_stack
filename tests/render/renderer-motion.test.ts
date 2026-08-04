import { describe, expect, it } from "vitest";

import {
  collapseCellVisualRow,
  garbageCellVisualRow,
  markedCellPresentationAt,
  presentationMotionTransform,
} from "../../src/render/renderer";
import {
  PresentationTimeline,
  type PresentationEffect,
} from "../../src/render/presentation-timeline";

function effect(
  kind: PresentationEffect["kind"],
  visualStyle: PresentationEffect["visualStyle"],
): PresentationEffect {
  return {
    id: `${kind}-${visualStyle}`,
    kind,
    board: "left",
    stage: "action",
    moment: kind === "offensive-transfer"
      ? "travel"
      : kind === "nuke"
        ? "shockwave"
        : kind === "collapse"
          ? "fall"
          : kind === "garbage-rise"
            ? "lift"
            : "glitch",
    progress: kind === "scramble" ? 0.47 : kind === "collapse" ? 0.2 : 0.5,
    stageProgress: 0.5,
    visualStyle,
    particleCount: visualStyle === "fade" ? 0 : 12,
    flash: false,
  };
}

describe("renderer presentation motion", () => {
  it("gives marked cells a strong special-colored breathing halo and stable reduced fallback", () => {
    const dim = markedCellPresentationAt(
      "blackout",
      "settled",
      "full",
      825,
    );
    const bright = markedCellPresentationAt(
      "blackout",
      "settled",
      "full",
      275,
    );

    expect(dim.accent).toBe(0x9b7bff);
    expect(bright.rimOpacity - dim.rimOpacity).toBeGreaterThan(0.2);
    expect(bright.haloScale - dim.haloScale).toBeGreaterThan(0.1);
    expect(bright.haloOpacity).toBeGreaterThan(0.3);

    const reducedAtStart = markedCellPresentationAt(
      "barrier",
      "settled",
      "reduced",
      0,
    );
    const reducedLater = markedCellPresentationAt(
      "barrier",
      "settled",
      "reduced",
      10_000,
    );
    const reducedEmphasized = markedCellPresentationAt(
      "barrier",
      "settled",
      "reduced",
      10_000,
      1,
    );
    expect(reducedAtStart).toEqual(reducedLater);
    expect(reducedAtStart).toEqual(reducedEmphasized);
    expect(reducedAtStart).toMatchObject({
      accent: 0x57e6ff,
      rimOpacity: expect.any(Number),
      haloOpacity: expect.any(Number),
    });
    expect(reducedAtStart.rimOpacity).toBeGreaterThanOrEqual(0.85);
  });

  it("subdues ghost markers and supports short spawn or lock emphasis", () => {
    const settled = markedCellPresentationAt(
      "glitch-core",
      "settled",
      "full",
      275,
    );
    const ghost = markedCellPresentationAt(
      "glitch-core",
      "ghost",
      "full",
      275,
    );
    const emphasized = markedCellPresentationAt(
      "glitch-core",
      "settled",
      "full",
      275,
      1,
    );

    expect(ghost.rimOpacity).toBeLessThan(settled.rimOpacity / 2);
    expect(ghost.haloOpacity).toBeLessThan(settled.haloOpacity / 2);
    expect(emphasized.haloScale).toBeGreaterThan(settled.haloScale);
    expect(emphasized.haloOpacity).toBeGreaterThan(settled.haloOpacity);
    expect(emphasized.emissiveIntensity).toBe(settled.emissiveIntensity);
  });

  it("turns travel and oscillation into static impact transforms for reduced motion", () => {
    expect(presentationMotionTransform(effect("offensive-transfer", "fade"))).toMatchObject({
      transferTravel: 1,
      nukeScale: 1,
      collapseTravel: 0,
      garbageLift: 0,
      scrambleOscillation: 0,
    });
    expect(presentationMotionTransform(effect("nuke", "fade")).nukeScale).toBe(1);
    expect(presentationMotionTransform(effect("collapse", "fade")).collapseTravel).toBe(0);
    expect(presentationMotionTransform(effect("garbage-rise", "fade")).garbageLift).toBe(0);
    expect(presentationMotionTransform(effect("scramble", "fade")).scrambleOscillation).toBe(0);
  });

  it("retains the full-motion transforms when motion is enabled", () => {
    expect(presentationMotionTransform(effect("offensive-transfer", "motion")).transferTravel)
      .toBeCloseTo(0.21875);
    expect(presentationMotionTransform(effect("nuke", "motion")).nukeScale).toBeCloseTo(1.19);
    expect(presentationMotionTransform(effect("collapse", "motion")).collapseTravel)
      .toBeCloseTo(0.5);
    expect(presentationMotionTransform(effect("garbage-rise", "motion")).garbageLift).toBe(0.5);
    expect(Math.abs(presentationMotionTransform(effect("scramble", "motion")).scrambleOscillation))
      .toBeGreaterThan(0.5);
  });

  it("turns Oversize and Ghost Jam cues into distinct motion transforms", () => {
    const oversizeTravel = {
      ...effect("offensive-transfer", "motion"),
      attack: "oversize" as const,
    };
    const oversizeImpact = {
      ...oversizeTravel,
      moment: "impact" as const,
      stageProgress: 0.2,
    };
    const ghostFlicker = {
      ...effect("ghost-jam", "motion"),
      moment: "ghost-flicker" as const,
      progress: 0.35,
    };
    const ghostDissolve = {
      ...ghostFlicker,
      moment: "ghost-dissolve" as const,
      stageProgress: 0.75,
    };

    expect(presentationMotionTransform(oversizeTravel).oversizeScale)
      .toBeGreaterThan(0.8);
    expect(presentationMotionTransform(oversizeImpact).oversizeScale)
      .toBeGreaterThan(presentationMotionTransform(oversizeTravel).oversizeScale);
    expect(Math.abs(presentationMotionTransform(ghostFlicker).ghostJamFlicker))
      .toBeGreaterThan(0.4);
    expect(presentationMotionTransform(ghostDissolve).ghostJamOpacity).toBeCloseTo(0.25);

    expect(
      presentationMotionTransform({ ...ghostDissolve, visualStyle: "fade" })
        .ghostJamFlicker,
    ).toBe(0);
  });

  it("keeps Collapse travel continuous through the fall", () => {
    const timeline = new PresentationTimeline();
    timeline.schedule(
      {
        id: "collapse-boundary",
        kind: "collapse",
        board: "left",
        completedRows: [],
        movements: [],
      },
      0,
    );
    const travel = [224, 225, 226].map((atMs) =>
      presentationMotionTransform(timeline.frameAt(atMs).effects[0]!).collapseTravel,
    );

    expect(travel[0]).toBeGreaterThan(travel[1]!);
    expect(travel[1]).toBeGreaterThan(travel[2]!);
    expect(travel[0]! - travel[2]!).toBeLessThan(0.02);
  });

  it("moves each compacted Collapse cell continuously from source to destination", () => {
    const timeline = new PresentationTimeline();
    timeline.schedule(
      {
        id: "collapse-cell",
        kind: "collapse",
        board: "left",
        completedRows: [],
        movements: [{ from: { x: 4, y: 17 }, to: { x: 4, y: 21 } }],
      },
      0,
    );
    const visualRows = [200, 325, 449, 450].map((atMs) =>
      collapseCellVisualRow(timeline.frameAt(atMs).effects[0]!, 4, 21),
    );

    expect(visualRows[0]).toBe(17);
    expect(visualRows[1]).toBeCloseTo(19);
    expect(visualRows[2]).toBeGreaterThan(20.9);
    expect(visualRows[3]).toBe(21);
    expect(visualRows).toEqual([...visualRows].sort((left, right) => left - right));
  });

  it("raises stack and new garbage cells from their pre-rise rows", () => {
    const timeline = new PresentationTimeline();
    timeline.schedule(
      {
        id: "garbage-cells",
        kind: "garbage-rise",
        board: "left",
        rowCount: 2,
      },
      0,
    );
    const visualRows = [0, 100, 175, 250].map((atMs) =>
      garbageCellVisualRow(timeline.frameAt(atMs).effects[0]!, 19),
    );

    expect(visualRows).toEqual([21, 21, 20, 19]);

    const reduced = new PresentationTimeline({ reducedMotion: true });
    reduced.schedule(
      {
        id: "garbage-cells-reduced",
        kind: "garbage-rise",
        board: "left",
        rowCount: 2,
      },
      0,
    );
    expect(garbageCellVisualRow(reduced.frameAt(0).effects[0]!, 19)).toBe(19);
  });
});
