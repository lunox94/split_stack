import { describe, expect, it } from "vitest";

import {
  audioPlanForLineClear,
  calloutForPower,
  cueForAcceptedInput,
  cueForIncomingAttack,
  cueForPhysicalEffect,
  panForPowerCue,
} from "../../src/app/audio-policy";

describe("app audio policy", () => {
  it("keeps line count SFX separate from consecutive-clear callouts", () => {
    expect(audioPlanForLineClear({
      rows: 3,
      comboCount: 1,
      clearOrigin: "piece",
    })).toEqual({ sfx: "triple", callout: null, calloutDelayMs: 70 });
    expect(audioPlanForLineClear({
      rows: 1,
      comboCount: 2,
      clearOrigin: "piece",
    })).toEqual({ sfx: "single", callout: "combo-2", calloutDelayMs: 70 });
    expect(audioPlanForLineClear({
      rows: 2,
      comboCount: 7,
      clearOrigin: "piece",
    })).toEqual({ sfx: "double", callout: "combo-5-plus", calloutDelayMs: 70 });
  });

  it("keeps Collapse clear sounds while excluding them from combo callouts", () => {
    expect(audioPlanForLineClear({
      rows: 4,
      comboCount: 4,
      clearOrigin: "power-collapse",
    })).toEqual({ sfx: "four-line", callout: null, calloutDelayMs: 70 });
  });

  it("maps every metered power to a semantic activation callout", () => {
    expect(calloutForPower("nuke")).toBe("power-nuke");
    expect(calloutForPower("ghost-jam")).toBe("power-ghost-jam");
  });

  it("plays input cues only when the simulation accepted the action", () => {
    expect(cueForAcceptedInput("move-left", true)).toBe("move");
    expect(cueForAcceptedInput("rotate-cw", true)).toBe("rotate");
    expect(cueForAcceptedInput("soft-drop", true)).toBe("soft-drop");
    expect(cueForAcceptedInput("move-left", false)).toBeNull();
    expect(cueForAcceptedInput("rotate-cw", false)).toBeNull();
  });

  it("gives affected players the new incoming power cues without duplicating legacy callbacks", () => {
    expect(cueForIncomingAttack("hollow-cross")).toBe("hollow-cross");
    expect(cueForIncomingAttack("oversize")).toBe("oversize-arrival");
    expect(cueForIncomingAttack("ghost-jam")).toBe("ghost-jam-arrival");
    expect(cueForIncomingAttack("garbage")).toBeNull();
    expect(cueForIncomingAttack("blackout")).toBeNull();
    expect(cueForIncomingAttack("scramble")).toBeNull();
  });

  it("keeps metered activation separate from physical power SFX", () => {
    expect(cueForPhysicalEffect({ kind: "power-activated", power: "nuke" }))
      .toBeNull();
    expect(cueForPhysicalEffect({ kind: "nuke", phase: "impact" }))
      .toBe("nuke-impact");
    expect(cueForPhysicalEffect({ kind: "collapse", phase: "drop" }))
      .toBe("collapse-impact");
    expect(cueForPhysicalEffect({ kind: "acid-dissolve", phase: "dissolve" }))
      .toBe("acid-consume");
  });

  it("pans opponent-targeting power cues toward the affected board", () => {
    expect(panForPowerCue("oversize", -0.45)).toBe(0.45);
    expect(panForPowerCue("ghost-jam", -0.45)).toBe(0.45);
    expect(panForPowerCue("scramble", -0.45)).toBe(0.45);
    expect(panForPowerCue("nuke", -0.45)).toBe(-0.45);
    expect(panForPowerCue("collapse", 0.45)).toBe(0.45);
  });
});
