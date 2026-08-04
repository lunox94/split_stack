import { describe, expect, it } from "vitest";

import {
  MusicSequencer,
  PROCEDURAL_TRACKS,
  selectTrackForMatch,
} from "../../src/audio/music";

describe("procedural match music", () => {
  it("selects one deterministic track per match and rotates on rematches", () => {
    const firstCycle = [0, 1, 2].map(
      (rematch) => selectTrackForMatch("shared-match-seed", rematch).id,
    );

    expect(PROCEDURAL_TRACKS.map((track) => track.title)).toEqual([
      "In the Hall of the Mountain King",
      "Flight of the Bumblebee",
      "Kalinka",
    ]);
    expect(new Set(firstCycle).size).toBe(3);
    expect(selectTrackForMatch("shared-match-seed", 0).id).toBe(firstCycle[0]);
    expect(selectTrackForMatch("shared-match-seed", 3).id).toBe(firstCycle[0]);
  });

  it("keeps tempo stable while adding harmony, percussion, and a danger pulse", () => {
    const sequencer = new MusicSequencer({
      matchSeed: "adaptive-score",
      rematchIndex: 0,
      startedAtMs: 0,
    });
    const calm = sequencer.eventsBetween(0, 4_000, "calm");
    const building = sequencer.eventsBetween(0, 4_000, "building");
    const danger = sequencer.eventsBetween(0, 4_000, "danger");

    const firstMelody = calm.find((event) => event.channel === "pulse-1");
    expect(firstMelody).toBeDefined();
    expect(building.find((event) => event.channel === "pulse-1")).toMatchObject({
      atMs: firstMelody?.atMs,
      frequencyHz: firstMelody?.frequencyHz,
    });
    expect(building.some((event) => event.channel === "pulse-2")).toBe(true);
    expect(building.some((event) => event.channel === "noise")).toBe(true);
    expect(
      danger.some(
        (event) => event.layer === "danger" && event.channel === "pulse-2",
      ),
    ).toBe(true);
    expect(danger.length).toBeGreaterThan(building.length);
  });

  it("pauses while hidden and resumes at the next beat boundary", () => {
    const sequencer = new MusicSequencer({
      matchSeed: "visibility",
      rematchIndex: 1,
      startedAtMs: 0,
    });
    const beatMs = 60_000 / sequencer.track.bpm;

    sequencer.pause(beatMs * 1.4);
    expect(sequencer.eventsBetween(2_000, 3_000, "danger")).toEqual([]);
    expect(sequencer.resume(5_000)).toBeCloseTo(beatMs * 2);
    expect(sequencer.positionAt(5_000)).toBeCloseTo(beatMs * 2);
    expect(sequencer.positionAt(5_000 + beatMs)).toBeCloseTo(beatMs * 3);
  });
});
