import { RULES } from "../config/rules";
import type { ClearKind } from "./types";

export interface ClearProgressInput {
  clearKind: ClearKind;
  level: number;
  previousComboIndex: number;
  backToBack: boolean;
  powerCreated?: boolean;
  allowCharge?: boolean;
  clearedLineCount?: number;
}

export interface ClearProgress {
  score: number;
  attackRows: number;
  charge: number;
  comboIndex: number;
  backToBack: boolean;
  difficult: boolean;
  hollowCross: boolean;
  lineCount: number;
}

interface ClearValues {
  score: number;
  attack: number;
  charge: number;
  lines: number;
  difficult: boolean;
}

const VALUES: Record<ClearKind, ClearValues> = {
  none: { score: 0, attack: 0, charge: 0, lines: 0, difficult: false },
  single: {
    score: RULES.scoring.single,
    attack: RULES.attacks.single,
    charge: RULES.charge.single,
    lines: 1,
    difficult: false,
  },
  double: {
    score: RULES.scoring.double,
    attack: RULES.attacks.double,
    charge: RULES.charge.double,
    lines: 2,
    difficult: false,
  },
  triple: {
    score: RULES.scoring.triple,
    attack: RULES.attacks.triple,
    charge: RULES.charge.triple,
    lines: 3,
    difficult: false,
  },
  tetris: {
    score: RULES.scoring.tetris,
    attack: RULES.attacks.tetris,
    charge: RULES.charge.tetris,
    lines: 4,
    difficult: true,
  },
  "t-spin-none": {
    score: RULES.scoring.tSpinNone,
    attack: 0,
    charge: 0,
    lines: 0,
    difficult: false,
  },
  "t-spin-single": {
    score: RULES.scoring.tSpinSingle,
    attack: RULES.attacks.tSpinSingle,
    charge: RULES.charge.tSpinSingle,
    lines: 1,
    difficult: true,
  },
  "t-spin-double": {
    score: RULES.scoring.tSpinDouble,
    attack: RULES.attacks.tSpinDouble,
    charge: RULES.charge.tSpinDouble,
    lines: 2,
    difficult: true,
  },
  "t-spin-triple": {
    score: RULES.scoring.tSpinTriple,
    attack: RULES.attacks.tSpinTriple,
    charge: RULES.charge.tSpinTriple,
    lines: 3,
    difficult: true,
  },
};

function comboBonus(comboIndex: number): number {
  const table = RULES.attacks.comboBonuses;
  return table[Math.min(comboIndex, table.length - 1)] ?? 0;
}

export function clearKindFor(lineCount: number, tSpin: boolean): ClearKind {
  if (tSpin) {
    if (lineCount <= 0) return "t-spin-none";
    if (lineCount === 1) return "t-spin-single";
    if (lineCount === 2) return "t-spin-double";
    return "t-spin-triple";
  }
  if (lineCount <= 0) return "none";
  if (lineCount === 1) return "single";
  if (lineCount === 2) return "double";
  if (lineCount === 3) return "triple";
  return "tetris";
}

export function resolveClearProgress(input: ClearProgressInput): ClearProgress {
  const values = VALUES[input.clearKind];
  const level = Math.max(1, Math.floor(input.level));
  const lineCount = input.clearedLineCount ?? values.lines;

  if (input.powerCreated === true) {
    return {
      score: values.score * level,
      attackRows: 0,
      charge: 0,
      comboIndex: input.previousComboIndex,
      backToBack: input.backToBack,
      difficult: false,
      hollowCross: false,
      lineCount,
    };
  }

  const lineClear = lineCount > 0;
  const comboIndex = lineClear ? input.previousComboIndex + 1 : -1;
  const receivesBackToBackBonus = values.difficult && input.backToBack;
  const baseScore = receivesBackToBackBonus
    ? Math.floor(
        (values.score * level * RULES.scoring.backToBackNumerator) /
          RULES.scoring.backToBackDenominator,
      )
    : values.score * level;
  const comboScore = lineClear ? RULES.scoring.combo * comboIndex * level : 0;
  const modifier = lineClear ? comboBonus(comboIndex) : 0;

  let nextBackToBack = input.backToBack;
  if (values.difficult) nextBackToBack = true;
  else if (lineClear) nextBackToBack = false;

  return {
    score: baseScore + comboScore,
    attackRows:
      values.attack +
      modifier +
      (receivesBackToBackBonus ? RULES.attacks.backToBackBonus : 0),
    charge:
      input.allowCharge === false
        ? 0
        : values.charge +
          modifier +
          (receivesBackToBackBonus ? RULES.charge.backToBackBonus : 0),
    comboIndex,
    backToBack: nextBackToBack,
    difficult: values.difficult,
    hollowCross: input.clearKind === "tetris",
    lineCount,
  };
}
