/**
 * xoshiro128** 1.1, ported from the public-domain reference implementation by
 * David Blackman and Sebastiano Vigna. All arithmetic is unsigned 32-bit.
 */
export type RngState = readonly [number, number, number, number];

const UINT32_RANGE = 0x1_0000_0000;

function rotateLeft(value: number, amount: number): number {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

function avalanche(value: number): number {
  let result = value >>> 0;
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d) >>> 0;
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b) >>> 0;
  result ^= result >>> 16;
  return result >>> 0;
}

/** Stable UTF-16 FNV-1a followed by a 32-bit avalanche. */
export function hashString32(value: string, salt = 0): number {
  let hash = (0x811c9dc5 ^ salt) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= code >>> 8;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return avalanche(hash ^ value.length);
}

export function deriveNamedState(seed: string, streamName: string): RngState {
  const canonicalSeed = seed.trim().toLowerCase();
  const source = `${canonicalSeed}\u001f${streamName}`;
  const words: [number, number, number, number] = [
    hashString32(source, 0x243f6a88),
    hashString32(source, 0x85a308d3),
    hashString32(source, 0x13198a2e),
    hashString32(source, 0x03707344),
  ];
  if (words.every((word) => word === 0)) words[0] = 1;
  return words;
}

export function deriveEventUint32(
  seed: string,
  eventId: string,
  purpose: string,
): number {
  return hashString32(`${seed.trim().toLowerCase()}\u001f${eventId}\u001f${purpose}`, 0xa4093822);
}

export class Xoshiro128StarStar {
  readonly #state: [number, number, number, number];

  constructor(state: RngState) {
    this.#state = state.map((word) => word >>> 0) as [number, number, number, number];
    if (this.#state.every((word) => word === 0)) {
      throw new Error("xoshiro128** requires a nonzero state");
    }
  }

  clone(): Xoshiro128StarStar {
    return new Xoshiro128StarStar(this.state());
  }

  state(): RngState {
    return [...this.#state] as [number, number, number, number];
  }

  nextUint32(): number {
    const result = Math.imul(
      rotateLeft(Math.imul(this.#state[1], 5) >>> 0, 7),
      9,
    ) >>> 0;
    const shifted = (this.#state[1] << 9) >>> 0;

    this.#state[2] = (this.#state[2] ^ this.#state[0]) >>> 0;
    this.#state[3] = (this.#state[3] ^ this.#state[1]) >>> 0;
    this.#state[1] = (this.#state[1] ^ this.#state[2]) >>> 0;
    this.#state[0] = (this.#state[0] ^ this.#state[3]) >>> 0;
    this.#state[2] = (this.#state[2] ^ shifted) >>> 0;
    this.#state[3] = rotateLeft(this.#state[3], 11);
    return result;
  }

  nextInt(exclusiveMaximum: number): number {
    if (!Number.isSafeInteger(exclusiveMaximum) || exclusiveMaximum <= 0) {
      throw new RangeError("exclusiveMaximum must be a positive safe integer");
    }
    const limit = UINT32_RANGE - (UINT32_RANGE % exclusiveMaximum);
    let candidate = this.nextUint32();
    while (candidate >= limit) candidate = this.nextUint32();
    return candidate % exclusiveMaximum;
  }

  shuffle<T>(values: readonly T[]): T[] {
    const copy = [...values];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = this.nextInt(index + 1);
      const value = copy[index];
      copy[index] = copy[swapIndex] as T;
      copy[swapIndex] = value as T;
    }
    return copy;
  }
}

export function createNamedRng(seed: string, streamName: string): Xoshiro128StarStar {
  return new Xoshiro128StarStar(deriveNamedState(seed, streamName));
}

