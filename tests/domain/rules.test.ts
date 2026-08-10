import { describe, expect, it } from "vitest";
import { RULES, gravityIntervalFor } from "../../src/config/rules";

describe("approved balance configuration", () => {
  it("keeps board, timing, garbage, and meter values in the peer-hashed config", () => {
    expect(RULES.rulesVersion).toBe(2);
    expect(RULES.board).toEqual({ width: 10, height: 22, hiddenRows: 2 });
    expect(RULES.timing).toMatchObject({
      ticksPerSecond: 60,
      levelTicks: 3600,
      lockDelayTicks: 30,
      lockResetCap: 15,
      lineClearTicks: 9,
      powerImpactTicks: 12,
      collapseDropTicks: 15,
      acidDissolveStepTicks: 1,
      dasMs: 140,
      arrMs: 35,
      softDropRepeatMs: 35,
    });
    expect(RULES.garbage).toMatchObject({
      warningTicks: 150,
      rowsPerLockCap: 4,
      barrierCapacity: 4,
    });
    expect(RULES.power.threshold).toBe(7);
    expect(RULES.power.nukeRadius).toBe(2);
    expect(RULES.network).toMatchObject({
      recoveryProbeMs: 250,
      recoveryStabilityMs: 500,
      unstablePeerMs: 3_000,
      missingPeerMs: 5_000,
      maxRollbackMs: 3_000,
      reconnectingMs: 8_000,
      reconnectSeatStaggerMs: 500,
      reconnectRetryBaseMs: 3_000,
      reconnectRetryMaxMs: 15_000,
      controllerReconnectGraceMs: 20_000,
      reconnectGraceMs: 60_000,
      resultConsensusMs: 20_000,
      fastResumeCountdownTicks: 45,
      rollbackResumeCountdownTicks: 120,
    });
  });

  it("hashes both canonical Hollow Cross variants and shared queue cap", () => {
    expect(RULES.hollowCross).toEqual({
      variants: {
        small: { cells: [[1, 0], [0, 1], [2, 1], [1, 2]], spawnX: 3, spawnY: 0 },
        large: {
          cells: [[2, 0], [2, 1], [0, 2], [1, 2], [3, 2], [4, 2], [2, 3], [2, 4]],
          cellKinds: ["I", "T", "J", "S", "Z", "L", "O", "cross"],
          spawnX: 2,
          spawnY: 0,
        },
      },
      queueCap: 1,
      overflowGarbageRows: 2,
    });
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

  it("contains exactly the approved competitive, Practice, and marked power sets", () => {
    expect(new Set(RULES.power.deck)).toEqual(
      new Set([
        "scramble",
        "nuke",
        "collapse",
        "monomino-rush",
        "acid-rain",
        "oversize",
        "ghost-jam",
      ]),
    );
    expect(RULES.power.practiceDeck).toEqual([
      "nuke",
      "collapse",
      "monomino-rush",
      "acid-rain",
    ]);
    expect(RULES.special.frequency).toBe(6);
    expect(RULES.special.typeBag).toEqual([
      "column-bomb",
      "garbage-core",
      "glitch-core",
      "blackout",
      "barrier",
    ]);
  });
});
