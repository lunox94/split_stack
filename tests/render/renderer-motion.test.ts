import { describe, expect, it } from "vitest";

import {
  collapseCellVisualRow,
  garbageCellVisualRow,
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

  it("raises settled stack cells one garbage row at a time without moving the live piece", () => {
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
    const visualRows = [0, 80, 150, 220, 330].map((atMs) =>
      garbageCellVisualRow(timeline.frameAt(atMs).effects[0]!, 19),
    );

    expect(visualRows).toEqual([21, 21, 20.5, 19.785714285714285, 19]);
    expect(garbageCellVisualRow(
      timeline.frameAt(150).effects[0]!,
      4,
      "active",
    )).toBe(4);
    expect(garbageCellVisualRow(
      timeline.frameAt(150).effects[0]!,
      8,
      "ghost",
    )).toBe(8);

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

  it("keeps one cumulative stack offset when extreme backlog overlaps batches", () => {
    const timeline = new PresentationTimeline();
    for (let index = 0; index < 3; index += 1) {
      timeline.schedule(
        {
          id: `garbage-backlog-${index}`,
          kind: "garbage-rise",
          board: "left",
          rowCount: 4,
        },
        0,
      );
    }

    const initial = timeline.frameAt(0).effects[0]!;
    expect(initial).toMatchObject({
      garbageStackRows: 12,
      garbageStackLiftRows: 0,
    });
    expect(garbageCellVisualRow(initial, 7)).toBe(19);

    const beforeEffects = timeline.frameAt(644).effects;
    const beforeOverlap = beforeEffects[beforeEffects.length - 1]!;
    const beforeRow = garbageCellVisualRow(beforeOverlap, 12);
    const overlap = timeline.frameAt(645).effects.filter((effect) =>
      effect.kind === "garbage-rise"
    );
    expect(overlap).toHaveLength(2);
    expect(overlap[0]!.garbageStackLiftRows).toBe(
      overlap[1]!.garbageStackLiftRows,
    );
    expect(garbageCellVisualRow(overlap[overlap.length - 1]!, 12))
      .toBeCloseTo(beforeRow, 1);
  });
});
