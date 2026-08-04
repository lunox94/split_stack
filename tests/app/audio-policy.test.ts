import { describe, expect, it } from "vitest";

import {
  cueForIncomingAttack,
  panForPowerCue,
} from "../../src/app/audio-policy";

describe("app audio policy", () => {
  it("gives affected players the new incoming power cues without duplicating legacy callbacks", () => {
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
