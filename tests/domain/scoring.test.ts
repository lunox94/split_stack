import { describe, expect, it } from "vitest";
import { resolveClearProgress } from "../../src/domain/scoring";

describe("score, combo, back-to-back, attack, and charge", () => {
  it("matches the worked B2B Tetris fixture", () => {
    expect(
      resolveClearProgress({
        clearKind: "tetris",
        level: 2,
        previousComboIndex: 3,
        backToBack: true,
      }),
    ).toMatchObject({
      score: 2_800,
      attackRows: 6,
      charge: 8,
      comboIndex: 4,
      backToBack: true,
      hollowCross: true,
    });
  });

  it("starts B2B without bonus and preserves it through a no-clear lock", () => {
    const first = resolveClearProgress({
      clearKind: "t-spin-double",
      level: 1,
      previousComboIndex: -1,
      backToBack: false,
    });
    const empty = resolveClearProgress({
      clearKind: "none",
      level: 1,
      previousComboIndex: first.comboIndex,
      backToBack: first.backToBack,
    });

    expect(first).toMatchObject({ score: 1_200, attackRows: 4, charge: 5, backToBack: true });
    expect(empty).toMatchObject({ score: 0, comboIndex: -1, backToBack: true });
  });

  it("scores a no-clear T-Spin but does not treat it as difficult", () => {
    expect(
      resolveClearProgress({
        clearKind: "t-spin-none",
        level: 3,
        previousComboIndex: 2,
        backToBack: true,
      }),
    ).toMatchObject({
      score: 1_200,
      attackRows: 0,
      charge: 0,
      comboIndex: -1,
      backToBack: true,
    });
  });

  it("breaks B2B on an ordinary clear", () => {
    expect(
      resolveClearProgress({
        clearKind: "single",
        level: 1,
        previousComboIndex: 0,
        backToBack: true,
      }),
    ).toMatchObject({ score: 150, comboIndex: 1, backToBack: false });
  });

  it("keeps combo and B2B untouched for a Collapse-created clear", () => {
    expect(
      resolveClearProgress({
        clearKind: "double",
        level: 2,
        previousComboIndex: 4,
        backToBack: true,
        powerCreated: true,
      }),
    ).toEqual({
      score: 600,
      attackRows: 0,
      charge: 0,
      comboIndex: 4,
      backToBack: true,
      difficult: false,
      hollowCross: false,
      lineCount: 2,
    });
  });
});

