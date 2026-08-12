import { describe, expect, it } from "vitest";

import {
  GarbageHapticSequencer,
  hapticDurationForSimulationEffect,
} from "../../src/app/haptic-policy";
import { planGarbageSequence } from "../../src/app/garbage-sequence";
import type { SimulationEffect } from "../../src/domain/simulation";

describe("simulation haptic policy", () => {
  const barrierBlock: SimulationEffect = { kind: "barrier-block", rows: 3 };

  it("uses one light pulse for a Barrier block on the protected local device", () => {
    expect(hapticDurationForSimulationEffect(barrierBlock, true, "left")).toBe(20);
  });

  it("times one escalating pulse to every seated local garbage row", () => {
    const sequencer = new GarbageHapticSequencer();
    expect(sequencer.schedule(
      planGarbageSequence(4, 0),
      true,
      "left",
      0,
    )).toEqual([0, 220, 18, 92, 22, 88, 26, 84, 30]);
  });

  it("resubmits pending pulses when a queued batch replaces the browser pattern", () => {
    const sequencer = new GarbageHapticSequencer();
    const first = planGarbageSequence(4, 0);
    const second = planGarbageSequence(4, 0, 550);
    sequencer.schedule(first, true, "left", 0);
    expect(sequencer.schedule(second, true, "left", 0)).toEqual([
      0, 220, 18, 92, 22, 88, 26, 84, 30,
      60, 18, 52, 22, 48, 26, 44, 30,
    ]);
  });

  it("keeps only the remainder of an in-progress pulse when rebuilding", () => {
    const sequencer = new GarbageHapticSequencer();
    sequencer.schedule(planGarbageSequence(1, 0), true, "left", 0);
    expect(sequencer.schedule(
      planGarbageSequence(1, 225),
      true,
      "left",
      225,
    )).toEqual([0, 0, 13, 207, 18]);
  });

  it("does not pulse disabled, remote, spectator, or unrelated effects", () => {
    expect(hapticDurationForSimulationEffect(barrierBlock, false, "left")).toBeNull();
    expect(hapticDurationForSimulationEffect(barrierBlock, true, "right")).toBeNull();
    expect(hapticDurationForSimulationEffect(
      { kind: "garbage-rise", rows: 3 },
      false,
      "left",
    )).toBeNull();
    expect(hapticDurationForSimulationEffect(
      { kind: "garbage-rise", rows: 3 },
      true,
      "right",
    )).toBeNull();
    const sequencer = new GarbageHapticSequencer();
    expect(sequencer.schedule(planGarbageSequence(3, 0), false, "left", 0))
      .toBeNull();
  });
});
