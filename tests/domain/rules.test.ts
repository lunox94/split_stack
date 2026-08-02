import { describe, expect, it } from "vitest";
import { RULES, gravityIntervalFor } from "../../src/config/rules";

describe("approved balance configuration", () => {
  it("keeps board, timing, garbage, and meter values in the peer-hashed config", () => {
    expect(RULES.board).toEqual({ width: 10, height: 22, hiddenRows: 2 });
    expect(RULES.timing).toMatchObject({
      ticksPerSecond: 60,
      levelTicks: 3600,
      lockDelayTicks: 30,
      lockResetCap: 15,
      dasMs: 140,
      arrMs: 35,
      softDropRepeatMs: 35,
    });
    expect(RULES.garbage).toMatchObject({
      warningTicks: 150,
      rowsPerLockCap: 4,
      barrierCapacity: 4,
    });
    expect(RULES.power.threshold).toBe(20);
  });

  it("matches the shared gravity table including level-nine alternation", () => {
    expect(RULES.gravity).toEqual({
      levelOneThroughEightTicks: [48, 39, 30, 23, 17, 12, 8, 6],
      levelNineTicks: [4, 5],
      levelTenPlusTicks: 3,
    });
    expect(Array.from({ length: 8 }, (_, index) => gravityIntervalFor(index + 1, 0))).toEqual([
      48, 39, 30, 23, 17, 12, 8, 6,
    ]);
    expect([0, 1, 2, 3].map((phase) => gravityIntervalFor(9, phase))).toEqual([4, 5, 4, 5]);
    expect(gravityIntervalFor(10, 0)).toBe(3);
    expect(gravityIntervalFor(99, 0)).toBe(3);
  });

  it("hashes the one-hole-per-packet no-repeat garbage policy", () => {
    expect(RULES.garbage.holePolicy).toEqual({
      perPacket: "single",
      allowConsecutiveRepeat: false,
    });
  });

  it("contains exactly the seven approved powers and three special types", () => {
    expect(new Set(RULES.power.deck)).toEqual(
      new Set([
        "blackout",
        "scramble",
        "nuke",
        "barrier",
        "collapse",
        "monomino-rush",
        "acid-rain",
      ]),
    );
    expect(RULES.special.typeBag).toEqual([
      "column-bomb",
      "garbage-core",
      "glitch-core",
    ]);
  });
});
