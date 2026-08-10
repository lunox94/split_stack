import { describe, expect, it, vi } from "vitest";
import { QUALITY_PROFILES, QualityController } from "../../src/render/quality";

describe("render quality controller", () => {
  it("keeps explicit quality immutable while throttling by its selected profile", () => {
    const quality = new QualityController({ initial: "reduced" });

    expect(quality.profile).toEqual(QUALITY_PROFILES.reduced);
    expect(quality.shouldRender(0)).toBe(true);
    expect(quality.shouldRender(16)).toBe(false);
    expect(quality.shouldRender(34)).toBe(true);
    expect(quality.profile).toEqual(QUALITY_PROFILES.reduced);
  });

  it("does not adapt a fixed profile while frames are skipped", () => {
    const quality = new QualityController();
    for (let time = 0; time <= 2_000; time += 20) quality.shouldRender(time);
    expect(quality.profile).toEqual(QUALITY_PROFILES.full);
  });

  it("changes only when explicitly set and resets cadence on suspension", () => {
    const onChange = vi.fn();
    const quality = new QualityController({ onChange });
    quality.set("limited");
    quality.shouldRender(100);
    quality.noteSuspension();

    expect(quality.profile).toEqual(QUALITY_PROFILES.limited);
    expect(quality.shouldRender(101)).toBe(true);
    expect(onChange).toHaveBeenCalledWith(QUALITY_PROFILES.limited);
  });
});
