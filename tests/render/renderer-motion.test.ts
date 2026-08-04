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
