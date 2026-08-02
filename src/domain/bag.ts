import { RULES, STANDARD_SHAPES } from "../config/rules";
import type { PowerKind, SpecialKind, StandardShape } from "./types";
import { createNamedRng, type Xoshiro128StarStar } from "./rng";

export interface DeterministicSequence<T> {
  at(index: number): T;
  take(start: number, count: number): T[];
}

class BagSequence<T> implements DeterministicSequence<T> {
  readonly #cards: readonly T[];
  readonly #rng: Xoshiro128StarStar;
  readonly #cache: T[] = [];

  constructor(cards: readonly T[], rng: Xoshiro128StarStar) {
    if (cards.length === 0) throw new Error("A bag must contain at least one card");
    this.#cards = cards;
    this.#rng = rng;
  }

  #fillThrough(index: number): void {
    while (this.#cache.length <= index) {
      this.#cache.push(...this.#rng.shuffle(this.#cards));
    }
  }

  at(index: number): T {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new RangeError("Sequence index must be a nonnegative safe integer");
    }
    this.#fillThrough(index);
    return this.#cache[index] as T;
  }

  take(start: number, count: number): T[] {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("Sequence count must be a nonnegative safe integer");
    }
    return Array.from({ length: count }, (_, offset) => this.at(start + offset));
  }
}

export function createBasePieceSequence(seed: string): DeterministicSequence<StandardShape> {
  return new BagSequence(STANDARD_SHAPES, createNamedRng(seed, "base-pieces"));
}

export function createPowerDeckSequence(seed: string): DeterministicSequence<PowerKind> {
  return new BagSequence(RULES.power.deck, createNamedRng(seed, "power-decks"));
}

export interface SpecialMarker {
  kind: SpecialKind;
  cellIndex: number;
}

export interface SpecialSchedule {
  at(standardPieceIndex: number): SpecialMarker | null;
}

class SeededSpecialSchedule implements SpecialSchedule {
  readonly #ordinalRng: Xoshiro128StarStar;
  readonly #markerRng: Xoshiro128StarStar;
  readonly #types: DeterministicSequence<SpecialKind>;
  readonly #specialOrdinals: number[] = [];
  readonly #markedCells: number[] = [];

  constructor(seed: string) {
    this.#ordinalRng = createNamedRng(seed, "special-schedule:ordinals");
    this.#markerRng = createNamedRng(seed, "special-schedule:markers");
    this.#types = new BagSequence(
      RULES.special.typeBag,
      createNamedRng(seed, "special-schedule:types"),
    );
  }

  #ordinalForCycle(cycle: number): number {
    while (this.#specialOrdinals.length <= cycle) {
      const shuffled = this.#ordinalRng.shuffle(
        Array.from({ length: RULES.special.frequency }, (_, index) => index),
      );
      this.#specialOrdinals.push(shuffled[0] as number);
      this.#markedCells.push(this.#markerRng.nextInt(4));
    }
    return this.#specialOrdinals[cycle] as number;
  }

  at(standardPieceIndex: number): SpecialMarker | null {
    if (!Number.isSafeInteger(standardPieceIndex) || standardPieceIndex < 0) {
      throw new RangeError("Standard piece index must be a nonnegative safe integer");
    }
    const cycle = Math.floor(standardPieceIndex / RULES.special.frequency);
    const ordinal = standardPieceIndex % RULES.special.frequency;
    if (ordinal !== this.#ordinalForCycle(cycle)) return null;

    return { kind: this.#types.at(cycle), cellIndex: this.#markedCells[cycle] as number };
  }
}

export function createSpecialSchedule(seed: string): SpecialSchedule {
  return new SeededSpecialSchedule(seed);
}
