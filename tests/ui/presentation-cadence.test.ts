import { describe, expect, it } from "vitest";

import { RuntimePresentationCadence } from "../../src/app/presentation-cadence";

describe("runtime presentation cadence", () => {
  it("caps competitive and spectator projection at 30 fps", () => {
    const cadence = new RuntimePresentationCadence();

    expect(cadence.shouldPresent("competitive", 0)).toBe(true);
    expect(cadence.shouldPresent("competitive", 16)).toBe(false);
    expect(cadence.shouldPresent("competitive", 29)).toBe(false);
    expect(cadence.shouldPresent("competitive", 34)).toBe(true);
    expect(cadence.shouldPresent("spectator", 50)).toBe(false);
    expect(cadence.shouldPresent("spectator", 68)).toBe(true);
  });

  it("never throttles practice and resets before the next networked match", () => {
    const cadence = new RuntimePresentationCadence();

    expect(cadence.shouldPresent("competitive", 100)).toBe(true);
    expect(cadence.shouldPresent("practice", 101)).toBe(true);
    expect(cadence.shouldPresent("practice", 102)).toBe(true);
    expect(cadence.shouldPresent("competitive", 103)).toBe(true);
  });
});
