import { describe, expect, it } from "vitest";

import {
  PresentationRouter,
  type PresentationScheduler,
} from "../../src/app/presentation-router";
import type { SimulationEffect } from "../../src/domain/simulation";
import type { PresentationCue } from "../../src/render/presentation-timeline";

class RecordingScheduler implements PresentationScheduler {
  readonly cues: PresentationCue[] = [];

  schedule(cue: PresentationCue): void {
    this.cues.push(cue);
  }
}

describe("PresentationRouter", () => {
  it("routes one authoritative local effect batch without duplicating impact events", () => {
    const scheduler = new RecordingScheduler();
    const router = new PresentationRouter(scheduler);
    const effects: SimulationEffect[] = [
      {
        kind: "line-clear",
        phase: "anticipation",
        rows: 2,
        cells: [{ x: 0, y: 20 }, { x: 1, y: 20 }, { x: 0, y: 21 }],
      },
      { kind: "line-clear", phase: "impact", rows: 2 },
      { kind: "garbage-attack", rows: 3, eventId: "garbage-1" },
      {
        kind: "power-activated",
        power: "nuke",
        phase: "anticipation",
        eventId: "nuke-1",
        target: { x: 4, y: 18 },
      },
      { kind: "nuke", phase: "impact", eventId: "nuke-1" },
      {
        kind: "power-activated",
        power: "acid-rain",
        phase: "anticipation",
        eventId: "acid-power-1",
      },
      {
        kind: "power-activated",
        power: "collapse",
        phase: "anticipation",
        eventId: "collapse-1",
      },
      {
        kind: "acid-lock",
        eventId: "acid-1",
        column: 6,
        cells: [{ x: 6, y: 7 }, { x: 6, y: 15 }],
      },
      { kind: "acid-dissolve", eventId: "acid-1:cell:1", cells: [{ x: 6, y: 7 }] },
      {
        kind: "collapse",
        phase: "drop",
        eventId: "collapse-1",
        movements: [{ from: { x: 8, y: 17 }, to: { x: 8, y: 21 } }],
      },
      {
        kind: "special-trigger",
        eventId: "special-1",
        special: "column-bomb",
        row: 20,
        column: 4,
      },
      {
        kind: "special-trigger",
        eventId: "special-2",
        special: "garbage-core",
        row: 21,
        column: 2,
      },
    ];

    router.consumeSimulationEffects(effects, "left");

    expect(scheduler.cues.map((cue) => cue.kind)).toEqual([
      "line-clear",
      "offensive-transfer",
      "nuke",
      "acid-rain",
      "collapse",
      "acid-dissolve",
      "collapse",
      "special-chain",
    ]);
    expect(scheduler.cues[0]).toMatchObject({ rows: [20, 21] });
    expect(scheduler.cues[1]).toMatchObject({
      attack: "garbage",
      source: "left",
      target: "right",
    });
    expect(scheduler.cues[2]).toMatchObject({
      center: { column: 4, row: 18 },
    });
    expect(scheduler.cues[3]).toMatchObject({
      id: "acid-power-1",
      kind: "acid-rain",
    });
    expect(scheduler.cues[4]).toMatchObject({
      id: "collapse-1",
      movements: [],
    });
    expect(scheduler.cues[5]).toMatchObject({
      column: 6,
      occupiedRows: [7, 15],
    });
    expect(scheduler.cues[6]).toMatchObject({
      movements: [{ from: { x: 8, y: 17 }, to: { x: 8, y: 21 } }],
    });
    expect(scheduler.cues[7]).toMatchObject({
      triggers: [
        { special: "column-bomb", row: 20, column: 4 },
        { special: "garbage-core", row: 21, column: 2 },
      ],
    });
  });

  it("routes authenticated incoming attacks toward the correct visible board", () => {
    const scheduler = new RecordingScheduler();
    const ghostCells = [
      { column: 3, row: 19 },
      { column: 4, row: 19 },
      { column: 5, row: 19 },
      { column: 4, row: 18 },
    ];
    const router = new PresentationRouter(
      scheduler,
      () => 0,
      (board) => board === "left" ? ghostCells : [],
    );

    router.consumeIncomingAttack("garbage", "incoming-garbage", 4);
    router.consumeIncomingAttack("scramble", "incoming-scramble");
    router.consumeIncomingAttack("blackout", "incoming-blackout");
    router.consumeIncomingAttack("oversize", "incoming-oversize");
    router.consumeIncomingAttack("ghost-jam", "incoming-ghost-jam");

    expect(scheduler.cues).toEqual([
      {
        id: "incoming-garbage",
        kind: "offensive-transfer",
        attack: "garbage",
        source: "right",
        target: "left",
      },
      {
        id: "incoming-scramble",
        kind: "scramble",
        board: "left",
      },
      {
        id: "incoming-blackout",
        kind: "blackout",
        board: "right",
      },
      {
        id: "incoming-oversize",
        kind: "offensive-transfer",
        attack: "oversize",
        source: "right",
        target: "left",
      },
      {
        id: "incoming-ghost-jam",
        kind: "ghost-jam",
        board: "left",
        ghostCells,
      },
    ]);
  });

  it("routes a Barrier block to the affected board", () => {
    const scheduler = new RecordingScheduler();
    const router = new PresentationRouter(scheduler, () => 125);

    router.consumeSimulationEffects([
      { kind: "barrier-block", rows: 2 },
    ], "right");

    expect(scheduler.cues).toEqual([
      {
        id: "presentation:1:barrier-block",
        kind: "barrier-hit",
        board: "right",
      },
    ]);
  });

  it("routes the new meter powers and embedded status triggers", () => {
    const scheduler = new RecordingScheduler();
    const remoteGhostCells = [
      { column: 6, row: 20 },
      { column: 7, row: 20 },
      { column: 8, row: 20 },
      { column: 7, row: 19 },
    ];
    const router = new PresentationRouter(
      scheduler,
      () => 0,
      (board) => board === "right" ? remoteGhostCells : [],
    );

    router.consumeSimulationEffects([
      {
        kind: "power-activated",
        power: "oversize",
        phase: "anticipation",
        eventId: "oversize-power",
      },
      {
        kind: "power-activated",
        power: "ghost-jam",
        phase: "anticipation",
        eventId: "ghost-jam-power",
      },
      { kind: "ghost-jam-start", eventId: "ghost-jam-power" },
      { kind: "blackout-start", eventId: "blackout-special" },
      { kind: "barrier-start", eventId: "barrier-special" },
    ], "left");

    expect(scheduler.cues).toEqual([
      {
        id: "oversize-power",
        kind: "offensive-transfer",
        attack: "oversize",
        source: "left",
        target: "right",
      },
      {
        id: "ghost-jam-power",
        kind: "offensive-transfer",
        attack: "ghost-jam",
        source: "left",
        target: "right",
      },
      {
        id: "ghost-jam-power:ghost-jam",
        kind: "ghost-jam",
        board: "right",
        ghostCells: remoteGhostCells,
      },
      {
        id: "blackout-special",
        kind: "offensive-transfer",
        attack: "blackout",
        source: "left",
        target: "right",
      },
      {
        id: "barrier-special",
        kind: "barrier",
        board: "left",
        capacity: 4,
      },
    ]);
  });
});
