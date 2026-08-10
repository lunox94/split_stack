import { describe, expect, it } from "vitest";
import { RULES_HASH } from "../../src/config/rules-hash";
import { canonicalize, hashCanonical } from "../../src/domain/hashing";

describe("canonical hashing", () => {
  it("is insensitive to object insertion order but preserves array order", () => {
    expect(canonicalize({ b: 2, a: [3, 1] })).toBe('{"a":[3,1],"b":2}');
    expect(hashCanonical({ b: 2, a: 1 })).toBe(hashCanonical({ a: 1, b: 2 }));
    expect(hashCanonical({ a: [1, 2] })).not.toBe(hashCanonical({ a: [2, 1] }));
  });

  it("rejects values that cannot participate in deterministic state", () => {
    expect(() => canonicalize({ value: Number.NaN })).toThrow(/finite/i);
    expect(() => canonicalize({ value: undefined })).toThrow(/undefined/i);
  });

  it("pins the version-two rules hash", () => {
    expect(RULES_HASH).toMatch(/^[0-9a-f]{8}$/);
    expect(RULES_HASH).toBe("aac74504");
  });
});
