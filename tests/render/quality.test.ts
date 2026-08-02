import { describe, expect, it, vi } from "vitest";
import {
  QUALITY_PROFILES,
  QualityController,
} from "../../src/render/quality";

describe("render quality controller", () => {
  it("caps reduced-effects rendering at a deterministic 30 FPS cadence", () => {
    const quality = new QualityController({ initial: "reduced" });

    expect(quality.profile).toEqual(QUALITY_PROFILES.reduced);
    expect(quality.shouldRender(0)).toBe(true);
    expect(quality.shouldRender(16)).toBe(false);
    expect(quality.shouldRender(29)).toBe(false);
    expect(quality.shouldRender(34)).toBe(true);
  });

  it("reduces expensive effects after five seconds over the 60 FPS budget", () => {
    const onChange = vi.fn();
    const quality = new QualityController({ onChange });
    quality.observeFrame(0);
    for (let timestamp = 20; timestamp <= 5_000; timestamp += 20) {
      quality.observeFrame(timestamp);
    }

    expect(quality.profile).toEqual(QUALITY_PROFILES.limited);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(QUALITY_PROFILES.limited);
  });

  it("keeps full quality when the rolling frame budget is met", () => {
    const quality = new QualityController();
    quality.observeFrame(0);
    for (let timestamp = 16; timestamp <= 5_008; timestamp += 16) {
      quality.observeFrame(timestamp);
    }

    expect(quality.profile).toEqual(QUALITY_PROFILES.full);
  });
});
