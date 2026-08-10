import { describe, expect, it } from "vitest";

import {
  cueForAcceptedInput,
  cueForIncomingAttack,
  panForPowerCue,
} from "../../src/app/audio-policy";

describe("app audio policy", () => {
  it("plays input cues only when the simulation accepted the action", () => {
    expect(cueForAcceptedInput("move-left", true)).toBe("move");
    expect(cueForAcceptedInput("rotate-cw", true)).toBe("rotate");
    expect(cueForAcceptedInput("soft-drop", true)).toBe("soft-drop");
    expect(cueForAcceptedInput("move-left", false)).toBeNull();
    expect(cueForAcceptedInput("rotate-cw", false)).toBeNull();
  });

  it("gives affected players the new incoming power cues without duplicating legacy callbacks", () => {
    expect(cueForIncomingAttack("hollow-cross")).toBe("hollow-cross");
    expect(cueForIncomingAttack("oversize")).toBe("power-oversize");
    expect(cueForIncomingAttack("ghost-jam")).toBe("power-ghost-jam");
    expect(cueForIncomingAttack("garbage")).toBeNull();
    expect(cueForIncomingAttack("blackout")).toBeNull();
    expect(cueForIncomingAttack("scramble")).toBeNull();
  });

  it("pans opponent-targeting power cues toward the affected board", () => {
    expect(panForPowerCue("oversize", -0.45)).toBe(0.45);
    expect(panForPowerCue("ghost-jam", -0.45)).toBe(0.45);
    expect(panForPowerCue("scramble", -0.45)).toBe(0.45);
    expect(panForPowerCue("nuke", -0.45)).toBe(-0.45);
    expect(panForPowerCue("collapse", 0.45)).toBe(0.45);
  });
});
