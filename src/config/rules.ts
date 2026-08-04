import type { PowerKind, SpecialKind } from "../domain/types";

export const STANDARD_SHAPES = ["I", "J", "L", "O", "S", "T", "Z"] as const;

export const RULES = {
  rulesVersion: 2,
  board: { width: 10, height: 22, hiddenRows: 2 },
  timing: {
    ticksPerSecond: 60,
    levelTicks: 3_600,
    lockDelayTicks: 30,
    lockResetCap: 15,
    lineClearTicks: 9,
    powerImpactTicks: 12,
    collapseDropTicks: 15,
    acidDissolveStepTicks: 1,
    dasMs: 140,
    arrMs: 35,
    softDropRepeatMs: 35,
  },
  gravity: {
    levelOneThroughEightTicks: [48, 39, 30, 23, 17, 12, 8, 6] as const,
    levelNineTicks: [4, 5] as const,
    levelTenPlusTicks: 3,
  },
  scoring: {
    softDrop: 1,
    hardDrop: 2,
    single: 100,
    double: 300,
    triple: 500,
    tetris: 800,
    tSpinNone: 400,
    tSpinSingle: 800,
    tSpinDouble: 1_200,
    tSpinTriple: 1_600,
    combo: 50,
    backToBackNumerator: 3,
    backToBackDenominator: 2,
  },
  attacks: {
    single: 0,
    double: 1,
    triple: 2,
    tetris: 3,
    tSpinSingle: 2,
    tSpinDouble: 4,
    tSpinTriple: 6,
    backToBackBonus: 1,
    comboBonuses: [0, 0, 1, 1, 2, 2, 3] as const,
  },
  charge: {
    single: 1,
    double: 2,
    triple: 3,
    tetris: 5,
    tSpinSingle: 3,
    tSpinDouble: 5,
    tSpinTriple: 7,
    backToBackBonus: 1,
    comboBonuses: [0, 0, 1, 1, 2, 2, 3] as const,
  },
  garbage: {
    warningTicks: 150,
    rowsPerLockCap: 4,
    barrierCapacity: 4,
    barrierTicks: 1_200,
    holePolicy: {
      perPacket: "single",
      allowConsecutiveRepeat: false,
    },
  },
  power: {
    threshold: 7,
    deck: [
      "blackout",
      "scramble",
      "nuke",
      "barrier",
      "collapse",
      "monomino-rush",
      "acid-rain",
    ] as readonly PowerKind[],
    blackoutTicks: 900,
    scrambleTicks: 600,
    nukeRadius: 2,
    monominoRushTicks: 480,
    acidRainPieces: 3,
    replacementQueueCap: 2,
  },
  special: {
    frequency: 10,
    typeBag: ["column-bomb", "garbage-core", "glitch-core"] as readonly SpecialKind[],
    glitchQueueCap: 2,
    glitchCycleMs: 150,
  },
  hollowCross: {
    cells: [
      [2, 0],
      [2, 1],
      [0, 2],
      [1, 2],
      [3, 2],
      [4, 2],
      [2, 3],
      [2, 4],
    ] as const,
    spawnX: 2,
    spawnY: 0,
    queueCap: 1,
    overflowGarbageRows: 2,
  },
  network: {
    snapshotTicks: 6,
    keepaliveMs: 1_000,
    retryMs: 250,
    missingPeerMs: 3_000,
    reconnectingMs: 5_000,
    reconnectGraceMs: 60_000,
    resultConsensusMs: 20_000,
    resumeCountdownTicks: 180,
    maxSnapshotBytes: 4_096,
    maxRealtimeBytes: 128_000,
    maxMessageDepth: 8,
    maxPendingCritical: 256,
  },
} as const;

export function gravityIntervalFor(level: number, gravityStep: number): number {
  const earlyTicks = RULES.gravity.levelOneThroughEightTicks;
  if (level <= 1) return earlyTicks[0];
  if (level <= 8) return earlyTicks[level - 1] ?? earlyTicks[7];
  if (level === 9) {
    const cycle = RULES.gravity.levelNineTicks;
    return cycle[Math.abs(Math.floor(gravityStep)) % cycle.length] ?? cycle[0];
  }
  return RULES.gravity.levelTenPlusTicks;
}
