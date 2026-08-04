import { describe, expect, it } from "vitest";
import { RULES, STANDARD_SHAPES } from "../../src/config/rules";
import {
  createBasePieceSequence,
  createOversizePieceSequence,
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

  it("shuffles one of every approved competitive power in each deck cycle", () => {
    const deck = createPowerDeckSequence(SEED, "competitive");
    const first = Array.from({ length: 7 }, (_, index) => deck.at(index));
    const second = Array.from({ length: 7 }, (_, index) => deck.at(index + 7));

    expect(new Set(first)).toEqual(new Set(RULES.power.deck));
    expect(new Set(second)).toEqual(new Set(RULES.power.deck));
  });

  it("uses a deterministic self-benefit-only four-power deck in Practice", () => {
    const first = createPowerDeckSequence(SEED, "practice").take(0, 8);
    const second = createPowerDeckSequence(SEED, "practice").take(0, 8);

    expect(first.slice(0, 4).sort()).toEqual([...RULES.power.practiceDeck].sort());
    expect(first.slice(4, 8).sort()).toEqual([...RULES.power.practiceDeck].sort());
    expect(second).toEqual(first);
  });

  it("marks exactly one standard piece per six with a five-card special bag", () => {
    const schedule = createSpecialSchedule(SEED);
    const firstThirty = Array.from({ length: 30 }, (_, index) => schedule.at(index));

    for (let cycle = 0; cycle < 5; cycle += 1) {
      expect(firstThirty.slice(cycle * 6, cycle * 6 + 6).filter(Boolean)).toHaveLength(1);
    }
    expect(new Set(firstThirty.filter(Boolean).map((entry) => entry?.kind))).toEqual(
      new Set(RULES.special.typeBag),
    );
    expect(firstThirty.filter(Boolean).every((entry) => (entry?.cellIndex ?? 4) < 4)).toBe(true);
  });

  it("shuffles I, J, L, S, T, and Z once per deterministic Oversize cycle", () => {
    const first = createOversizePieceSequence(SEED).take(0, 12);
    const second = createOversizePieceSequence(SEED).take(0, 12);

    expect(first.slice(0, 6).sort()).toEqual([...RULES.power.oversizeShapes].sort());
    expect(first.slice(6, 12).sort()).toEqual([...RULES.power.oversizeShapes].sort());
    expect(second).toEqual(first);
  });
});
