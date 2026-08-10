import { describe, expect, it } from "vitest";

import { PresentationTimeline } from "../../src/render/presentation-timeline";

describe("presentation timeline", () => {
  it("reconfigures particles without changing scheduled cue timing or identity", () => {
    const timeline = new PresentationTimeline();
    timeline.schedule({ id: "nuke", kind: "nuke", board: "left", center: { column: 4, row: 10 } }, 0);
    const before = timeline.frameAt(325).effects[0];

    timeline.configure({ particleScale: 0.45, screenShake: false });
    const configuredFrame = timeline.frameAt(325);
    const after = configuredFrame.effects[0];

    expect(after).toMatchObject({ id: "nuke", stage: before?.stage, particleCount: 22 });
    expect(configuredFrame.shake).toBeNull();
    timeline.configure({ reducedMotion: true });
    expect(timeline.frameAt(325).effects[0]).toMatchObject({ id: "nuke", particleCount: 0, visualStyle: "fade" });
  });

  it("gives every normal line clear the same 150 ms blocking rhythm", () => {
    const single = new PresentationTimeline();
    const fourLine = new PresentationTimeline();

    const singleTiming = single.schedule(
      { id: "single", kind: "line-clear", board: "left", rows: [21] },
      1_000,
    );
    const fourLineTiming = fourLine.schedule(
      {
        id: "four",
        kind: "line-clear",
        board: "left",
        rows: [18, 19, 20, 21],
      },
      1_000,
    );

    expect(singleTiming.blockingUntilMs).toBe(150);
    expect(fourLineTiming.blockingUntilMs).toBe(150);
    expect(single.frameAt(1_075)).toMatchObject({
      blocking: true,
      effects: [{ id: "single", stage: "anticipation", moment: "compress" }],
    });
    expect(single.frameAt(1_135)).toMatchObject({
      blocking: true,
      effects: [{ id: "single", stage: "action", moment: "impact" }],
    });
    expect(single.frameAt(1_160)).toMatchObject({
      blocking: false,
      effects: [{ id: "single", stage: "follow-through" }],
    });
  });

  it("choreographs offensive effects from source charge through target impact", () => {
    const timeline = new PresentationTimeline();
    const timing = timeline.schedule(
      {
        id: "scramble-a-b",
        kind: "offensive-transfer",
        attack: "scramble",
        source: "left",
        target: "right",
      },
      0,
    );

    expect(timing.impactAtMs).toBe(200);
    expect(timeline.frameAt(40).effects[0]).toMatchObject({
      moment: "charge",
      source: "left",
      target: "right",
    });
    expect(timeline.frameAt(150).effects[0]).toMatchObject({ moment: "travel" });
    expect(timeline.frameAt(225).effects[0]).toMatchObject({
      stage: "action",
      moment: "impact",
    });
    expect(timeline.frameAt(300).effects[0]).toMatchObject({
      stage: "follow-through",
    });
  });

  it("expands Oversize as it travels toward the targeted queue", () => {
    const timeline = new PresentationTimeline();
    timeline.schedule(
      {
        id: "oversize-a-b",
        kind: "offensive-transfer",
        attack: "oversize",
        source: "left",
        target: "right",
      },
      0,
    );

    expect(timeline.frameAt(40).effects[0]).toMatchObject({
      attack: "oversize",
      moment: "charge",
    });
    expect(timeline.frameAt(150).effects[0]).toMatchObject({
      attack: "oversize",
      moment: "travel",
    });
    expect(timeline.frameAt(220).effects[0]).toMatchObject({
      attack: "oversize",
      moment: "impact",
      board: "right",
    });
  });

  it("flickers then dissolves a Ghost Jam target with a static accessible fallback", () => {
    const full = new PresentationTimeline();
    const ghostCells = [
      { column: 3, row: 18 },
      { column: 4, row: 18 },
      { column: 5, row: 18 },
      { column: 4, row: 17 },
    ];
    full.schedule({ id: "jam", kind: "ghost-jam", board: "right", ghostCells }, 0);

    expect(full.frameAt(50).effects[0]).toMatchObject({
      kind: "ghost-jam",
      moment: "ghost-flicker",
      visualStyle: "motion",
      ghostCells,
    });
    expect(full.frameAt(220).effects[0]).toMatchObject({
      stage: "action",
      moment: "ghost-dissolve",
    });

    const reduced = new PresentationTimeline({ reducedMotion: true });
    reduced.schedule({
      id: "jam-reduced",
      kind: "ghost-jam",
      board: "left",
      ghostCells,
    }, 0);
    expect(reduced.frameAt(50).effects[0]).toMatchObject({
      moment: "ghost-flicker",
      visualStyle: "fade",
      particleCount: 0,
    });
  });

  it("telegraphs a five-by-five Nuke before its shockwave", () => {
    const timeline = new PresentationTimeline();
    timeline.schedule(
      {
        id: "nuke",
        kind: "nuke",
        board: "left",
        center: { column: 6, row: 14 },
      },
      100,
    );

    expect(timeline.frameAt(200).effects[0]).toMatchObject({
      moment: "reticle",
      footprint: { width: 5, height: 5 },
      center: { column: 6, row: 14 },
    });
    expect(timeline.frameAt(325).effects[0]).toMatchObject({
      stage: "action",
      moment: "shockwave",
    });
    expect(timeline.frameAt(500).effects[0]).toMatchObject({
      stage: "follow-through",
      moment: "particles",
    });
  });

  it("dissolves an Acid Rain column from top to bottom one cell at a time", () => {
    const timeline = new PresentationTimeline();
    const timing = timeline.schedule(
      {
        id: "acid-contact",
        kind: "acid-dissolve",
        board: "right",
        column: 4,
        occupiedRows: [18, 7, 12],
      },
      0,
    );

    expect(timing.blockingUntilMs).toBeLessThanOrEqual(350);
    expect(timeline.frameAt(20).effects[0]).toMatchObject({ moment: "splash" });
    expect(timeline.frameAt(40).effects[0]).toMatchObject({
      moment: "dissolve",
      column: 4,
      resolvedRows: [7],
    });
    expect(timeline.frameAt(75).effects[0]).toMatchObject({
      resolvedRows: [7, 12],
    });
    expect(timeline.frameAt(110).effects[0]).toMatchObject({
      resolvedRows: [7, 12, 18],
    });
  });

  it("warns about garbage pressure without exposing holes before the rise", () => {
    const timeline = new PresentationTimeline();
    timeline.schedule(
      { id: "garbage", kind: "garbage-rise", board: "left", rowCount: 4 },
      0,
    );

    expect(timeline.frameAt(50).effects[0]).toMatchObject({
      moment: "pressure",
      rowCount: 4,
    });
    expect(timeline.frameAt(175).effects[0]).toMatchObject({
      stage: "action",
      moment: "lift",
      rowCount: 4,
    });
    expect(timeline.frameAt(50).effects[0]).not.toHaveProperty("holeColumns");
  });

  it("drops Collapse cells before using the standard row-clear anticipation", () => {
    const timeline = new PresentationTimeline();
    const timing = timeline.schedule(
      {
        id: "collapse",
        kind: "collapse",
        board: "right",
        completedRows: [20],
        movements: [{ from: { x: 3, y: 16 }, to: { x: 3, y: 20 } }],
      },
      0,
    );

    expect(timing.impactAtMs).toBe(200);
    expect(timing.blockingUntilMs).toBeLessThanOrEqual(500);
    expect(timeline.frameAt(125).effects[0]).toMatchObject({
      moment: "charge",
    });
    expect(timeline.frameAt(325).effects[0]).toMatchObject({
      moment: "fall",
      movements: [{ from: { x: 3, y: 16 }, to: { x: 3, y: 20 } }],
    });
    expect(timeline.frameAt(475).effects[0]).toMatchObject({
      stage: "follow-through",
      moment: "particles",
    });
  });

  it("adds Collapse movements at power impact without restarting its charge cue", () => {
    const timeline = new PresentationTimeline();
    timeline.schedule(
      {
        id: "collapse-transition",
        kind: "collapse",
        board: "left",
        completedRows: [],
        movements: [],
      },
      0,
    );
    timeline.schedule(
      {
        id: "collapse-transition",
        kind: "collapse",
        board: "left",
        completedRows: [],
        movements: [{ from: { x: 1, y: 17 }, to: { x: 1, y: 21 } }],
      },
      200,
    );

    expect(timeline.frameAt(201).effects[0]).toMatchObject({
      stage: "action",
      moment: "fall",
      movements: [{ from: { x: 1, y: 17 }, to: { x: 1, y: 21 } }],
    });
  });

  it("gives each status power a distinct readable activation", () => {
    const timeline = new PresentationTimeline();
    timeline.schedule(
      { id: "barrier", kind: "barrier", board: "left", capacity: 4 },
      0,
    );
    timeline.schedule({ id: "blackout", kind: "blackout", board: "right" }, 0);
    timeline.schedule({ id: "scramble", kind: "scramble", board: "left" }, 0);
    timeline.schedule(
      { id: "monomino", kind: "monomino-rush", board: "right" },
      0,
    );
    timeline.schedule({ id: "acid", kind: "acid-rain", board: "left" }, 0);
    timeline.schedule({
      id: "ghost-jam",
      kind: "ghost-jam",
      board: "right",
      ghostCells: [],
    }, 0);

    expect(timeline.frameAt(50).effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "barrier", moment: "rail", capacity: 4 }),
        expect.objectContaining({ id: "blackout", moment: "veil" }),
        expect.objectContaining({ id: "scramble", moment: "glitch" }),
        expect.objectContaining({ id: "monomino", moment: "fracture" }),
        expect.objectContaining({ id: "acid", moment: "charge" }),
        expect.objectContaining({ id: "ghost-jam", moment: "ghost-flicker" }),
      ]),
    );
  });

  it("shows a nonblocking Barrier hit for 220 ms with reduced variants", () => {
    const full = new PresentationTimeline();
    const cue = {
      id: "barrier-hit",
      kind: "barrier-hit" as const,
      board: "right" as const,
    };

    expect(full.schedule(cue, 1_000)).toEqual({
      impactAtMs: 0,
      blockingUntilMs: 0,
      durationMs: 220,
    });
    expect(full.frameAt(1_000)).toMatchObject({
      blocking: false,
      effects: [{
        id: "barrier-hit",
        kind: "barrier-hit",
        board: "right",
        stage: "action",
        moment: "impact",
        visualStyle: "motion",
        flash: true,
      }],
    });
    expect(full.frameAt(1_219).effects).toHaveLength(1);
    expect(full.frameAt(1_220).effects).toHaveLength(0);

    const reducedMotion = new PresentationTimeline({ reducedMotion: true });
    reducedMotion.schedule(cue, 0);
    expect(reducedMotion.frameAt(110).effects[0]).toMatchObject({
      stage: "action",
      moment: "impact",
      visualStyle: "fade",
      particleCount: 0,
      flash: true,
    });

    const reducedFlashes = new PresentationTimeline({ reducedFlashes: true });
    reducedFlashes.schedule(cue, 0);
    expect(reducedFlashes.frameAt(110).effects[0]).toMatchObject({
      visualStyle: "motion",
      flash: false,
    });
  });

  it("preserves competitive timing while reduced motion removes shake and particles", () => {
    const full = new PresentationTimeline({
      reducedMotion: false,
      reducedFlashes: false,
      screenShake: true,
      particleScale: 1,
    });
    const reduced = new PresentationTimeline({
      reducedMotion: true,
      reducedFlashes: true,
      screenShake: false,
      particleScale: 0,
    });
    const cue = {
      id: "major-nuke",
      kind: "nuke" as const,
      board: "left" as const,
      center: { column: 5, row: 18 },
    };

    expect(reduced.schedule(cue, 0)).toEqual(full.schedule(cue, 0));
    const fullImpact = full.frameAt(210);
    const reducedImpact = reduced.frameAt(210);

    expect(reducedImpact.effects[0]?.stage).toBe(fullImpact.effects[0]?.stage);
    expect(fullImpact).toMatchObject({
      effects: [{ visualStyle: "motion", particleCount: 48, flash: true }],
    });
    expect(fullImpact.shake).not.toBeNull();
    expect(reducedImpact).toMatchObject({
      effects: [{ visualStyle: "fade", particleCount: 0, flash: false }],
      shake: null,
    });
  });

  it("reveals marked-cell chains bottom-row first and left-to-right", () => {
    const timeline = new PresentationTimeline();
    const timing = timeline.schedule(
      {
        id: "specials",
        kind: "special-chain",
        board: "left",
        triggers: [
          { special: "glitch-core", row: 18, column: 7 },
          { special: "column-bomb", row: 20, column: 6 },
          { special: "garbage-core", row: 20, column: 2 },
        ],
      },
      0,
    );

    expect(timing.blockingUntilMs).toBeLessThanOrEqual(400);
    expect(timeline.frameAt(80).effects[0]).toMatchObject({
      moment: "special-burst",
      resolvedSpecials: [{ special: "garbage-core", row: 20, column: 2 }],
    });
    expect(timeline.frameAt(190).effects[0]).toMatchObject({
      resolvedSpecials: [
        { special: "garbage-core", row: 20, column: 2 },
        { special: "column-bomb", row: 20, column: 6 },
        { special: "glitch-core", row: 18, column: 7 },
      ],
    });
  });

  it("bounds simultaneous visual cues for low-memory mobile runtimes", () => {
    const timeline = new PresentationTimeline();
    for (let index = 0; index < 100; index += 1) {
      timeline.schedule(
        {
          id: `clear-${index}`,
          kind: "line-clear",
          board: "left",
          rows: [21],
        },
        0,
      );
    }

    expect(timeline.frameAt(50).effects).toHaveLength(64);
  });
});
