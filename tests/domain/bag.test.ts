import { describe, expect, it } from "vitest";
import { RULES, STANDARD_SHAPES } from "../../src/config/rules";
import {
  createBasePieceSequence,
  createPowerDeckSequence,
  createSpecialSchedule,
} from "../../src/domain/bag";

const SEED = "00112233445566778899aabbccddeeff";

describe("seeded bags", () => {
  it("gives both players identical independently readable seven-bags", () => {
    const playerA = createBasePieceSequence(SEED);
    const playerB = createBasePieceSequence(SEED);
    const firstFourteen = Array.from({ length: 14 }, (_, index) => playerA.at(index));

    expect(firstFourteen.slice(0, 7).sort()).toEqual([...STANDARD_SHAPES].sort());
    expect(firstFourteen.slice(7, 14).sort()).toEqual([...STANDARD_SHAPES].sort());
    expect(Array.from({ length: 14 }, (_, index) => playerB.at(index))).toEqual(firstFourteen);
    expect(firstFourteen).toEqual([
      "Z", "S", "I", "T", "J", "L", "O",
      "Z", "O", "S", "T", "L", "J", "I",
    ]);
  });

  it("shuffles one of every approved power in each deck cycle", () => {
    const deck = createPowerDeckSequence(SEED);
    const first = Array.from({ length: 7 }, (_, index) => deck.at(index));
    const second = Array.from({ length: 7 }, (_, index) => deck.at(index + 7));

    expect(new Set(first)).toEqual(new Set(RULES.power.deck));
    expect(new Set(second)).toEqual(new Set(RULES.power.deck));
    expect(first).toEqual([
      "nuke",
      "blackout",
      "barrier",
      "acid-rain",
      "scramble",
      "collapse",
      "monomino-rush",
    ]);
  });

  it("marks exactly one standard piece per ten with a three-card special bag", () => {
    const schedule = createSpecialSchedule(SEED);
    const firstThirty = Array.from({ length: 30 }, (_, index) => schedule.at(index));

    for (let cycle = 0; cycle < 3; cycle += 1) {
      expect(firstThirty.slice(cycle * 10, cycle * 10 + 10).filter(Boolean)).toHaveLength(1);
    }
    expect(firstThirty.filter(Boolean).map((entry) => entry?.kind)).toEqual([
      "garbage-core",
      "column-bomb",
      "glitch-core",
    ]);
    expect(firstThirty.filter(Boolean).every((entry) => (entry?.cellIndex ?? 4) < 4)).toBe(true);
  });
});
