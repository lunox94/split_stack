import { describe, expect, it } from "vitest";

import { RoundTripEstimator } from "../../src/network/rtt-estimator";

describe("RoundTripEstimator", () => {
  it("uses the first sample as the smoothed RTT and half as variation", () => {
    const estimator = new RoundTripEstimator();

    expect(estimator.current()).toBeNull();
    expect(estimator.observe(800)).toEqual({
      smoothedMs: 800,
      variationMs: 400,
    });
  });

  it("smooths later samples without retaining a history", () => {
    const estimator = new RoundTripEstimator();
    estimator.observe(800);

    expect(estimator.observe(400)).toEqual({
      smoothedMs: 750,
      variationMs: 400,
    });
    expect(estimator.current()).toEqual({
      smoothedMs: 750,
      variationMs: 400,
    });
  });

  it("rejects invalid timing samples", () => {
    const estimator = new RoundTripEstimator();

    expect(() => estimator.observe(-1)).toThrow(RangeError);
    expect(() => estimator.observe(Number.NaN)).toThrow(RangeError);
  });
});
