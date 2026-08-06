import { describe, expect, it } from "vitest";

import { hapticDurationForSimulationEffect } from "../../src/app/haptic-policy";
import type { SimulationEffect } from "../../src/domain/simulation";

describe("simulation haptic policy", () => {
  const barrierBlock: SimulationEffect = { kind: "barrier-block", rows: 3 };

  it("uses one light pulse for a Barrier block on the protected local device", () => {
    expect(hapticDurationForSimulationEffect(barrierBlock, true, "left")).toBe(20);
  });

  it("does not pulse disabled, remote, spectator, or unrelated effects", () => {
    expect(hapticDurationForSimulationEffect(barrierBlock, false, "left")).toBeNull();
    expect(hapticDurationForSimulationEffect(barrierBlock, true, "right")).toBeNull();
    expect(hapticDurationForSimulationEffect(
      { kind: "garbage-rise", rows: 3 },
      true,
      "left",
    )).toBeNull();
  });
});
