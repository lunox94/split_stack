import { describe, expect, it } from "vitest";

import {
  MatchTickClock,
  calculateClockSample,
  selectClockOffset,
} from "../../src/network/clock";

describe("clock synchronization", () => {
  it("uses the median offset from the three lowest-RTT samples", () => {
    const samples = [
      calculateClockSample(0, 105, 106, 11, 0),
      calculateClockSample(20, 125, 126, 27, 1),
      calculateClockSample(40, 142, 143, 49, 2),
      calculateClockSample(60, 580, 581, 101, 3),
      calculateClockSample(1_000, 715, 716, 1_031, 4),
    ];

    expect(selectClockOffset(samples)).toEqual({
      offsetPeerMinusCoordinatorMs: 100,
      selectedSampleIds: [1, 2, 0],
    });
  });

  it("requires exactly five valid samples", () => {
    const sample = calculateClockSample(0, 105, 106, 11, 0);
    expect(() => selectClockOffset([sample, sample, sample, sample])).toThrow(
      /five/i,
    );
    expect(() => selectClockOffset([sample, sample, sample, sample, sample])).toThrow(
      /distinct/i,
    );
    expect(() => calculateClockSample(10, 11, 9, 12, 0)).toThrow(/timestamp/i);
  });
});

describe("MatchTickClock", () => {
  it("derives ticks from a synchronized monotonic epoch and freezes while paused", () => {
    const clock = new MatchTickClock(60);
    clock.scheduleStart(1_000, 0);

    expect(clock.tickAt(999)).toBe(0);
    expect(clock.tickAt(1_100)).toBe(6);
    expect(clock.pauseAt(1_250)).toBe(15);
    expect(clock.tickAt(8_000)).toBe(15);

    clock.scheduleResume(9_000);
    expect(clock.tickAt(9_000)).toBe(15);
    expect(clock.tickAt(9_100)).toBe(21);
  });
});
