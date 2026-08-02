import { describe, expect, it } from "vitest";
import {
  Xoshiro128StarStar,
  deriveEventUint32,
  deriveNamedState,
} from "../../src/domain/rng";

describe("deterministic randomness", () => {
  it("matches the published xoshiro128** 1.1 transition vector", () => {
    const random = new Xoshiro128StarStar([1, 2, 3, 4]);

    expect(Array.from({ length: 10 }, () => random.nextUint32())).toEqual([
      0x00002d00,
      0x00000000,
      0x005a7080,
      0x04389d80,
      0x79199d9b,
      0x61963b24,
      0x4cb9b57a,
      0xde9d7431,
      0xde458f35,
      0xfdce1a54,
    ]);
  });

  it("creates identical cursors for a named stream without coupling other streams", () => {
    const seed = "00112233445566778899aabbccddeeff";
    const first = new Xoshiro128StarStar(deriveNamedState(seed, "base-pieces"));
    const second = new Xoshiro128StarStar(deriveNamedState(seed, "base-pieces"));
    const powers = new Xoshiro128StarStar(deriveNamedState(seed, "power-decks"));

    expect(Array.from({ length: 8 }, () => first.nextUint32())).toEqual(
      Array.from({ length: 8 }, () => second.nextUint32()),
    );
    expect(first.nextUint32()).not.toBe(powers.nextUint32());
  });

  it("derives event values without consuming a mutable cursor", () => {
    const seed = "00112233445566778899aabbccddeeff";

    expect(deriveEventUint32(seed, "attack:7", "garbage-hole")).toBe(
      deriveEventUint32(seed, "attack:7", "garbage-hole"),
    );
    expect(deriveEventUint32(seed, "attack:7", "garbage-hole")).not.toBe(
      deriveEventUint32(seed, "attack:8", "garbage-hole"),
    );
  });

  it("rejects the forbidden all-zero state", () => {
    expect(() => new Xoshiro128StarStar([0, 0, 0, 0])).toThrow(/nonzero/i);
  });
});

