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

  it("reduces expensive effects after a short sustained frame-budget miss", () => {
    const onChange = vi.fn();
    const quality = new QualityController({ onChange });
    quality.observeFrame(0);
    for (let timestamp = 20; timestamp <= 1_500; timestamp += 20) {
      quality.observeFrame(timestamp);
    }

    expect(quality.profile).toEqual(QUALITY_PROFILES.limited);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(QUALITY_PROFILES.limited);
  });

  it("reaches the 30 FPS fallback when overload continues at limited quality", () => {
    const onChange = vi.fn();
    const quality = new QualityController({ onChange });
    quality.observeFrame(0);
    for (let timestamp = 20; timestamp <= 3_020; timestamp += 20) {
      quality.observeFrame(timestamp);
    }

    expect(quality.profile).toEqual(QUALITY_PROFILES.reduced);
    expect(onChange.mock.calls.map(([profile]) => profile.effects)).toEqual([
      "limited",
      "reduced",
    ]);
    expect(quality.shouldRender(3_000)).toBe(true);
    expect(quality.shouldRender(3_016)).toBe(false);
    expect(quality.shouldRender(3_034)).toBe(true);
  });

  it("keeps full quality when the rolling frame budget is met", () => {
    const quality = new QualityController();
    quality.observeFrame(0);
    for (let timestamp = 16; timestamp <= 5_008; timestamp += 16) {
      quality.observeFrame(timestamp);
    }

    expect(quality.profile).toEqual(QUALITY_PROFILES.full);
  });

  it("does not treat a suspended scheduling gap as sustained overload", () => {
    const quality = new QualityController();
    quality.observeFrame(0);
    quality.noteSuspension();
    quality.observeFrame(5_000);
    for (let timestamp = 5_016; timestamp <= 6_504; timestamp += 16) {
      quality.observeFrame(timestamp);
    }

    expect(quality.profile).toEqual(QUALITY_PROFILES.full);
  });

  it("degrades after a severe scheduling gap while presentation remains visible", () => {
    const quality = new QualityController();
    quality.observeFrame(0);

    quality.observeFrame(5_000, 30);

    expect(quality.profile).toEqual(QUALITY_PROFILES.limited);
  });

  it("degrades promptly when foreground frames become very slow", () => {
    const quality = new QualityController();

    quality.observeFrame(0);
    for (let timestamp = 250; timestamp <= 3_250; timestamp += 250) {
      quality.observeFrame(timestamp);
    }

    expect(quality.profile).toEqual(QUALITY_PROFILES.reduced);
  });

  it("does not degrade when presentation is intentionally capped at 30 fps", () => {
    const quality = new QualityController();

    for (let timestamp = 0; timestamp <= 4_000; timestamp += 34) {
      quality.observeFrame(timestamp, 30);
    }

    expect(quality.profile).toEqual(QUALITY_PROFILES.full);
  });

  it("does not reduce limited quality again after frame cadence recovers", () => {
    const quality = new QualityController();
    quality.observeFrame(0);
    for (let timestamp = 20; timestamp <= 1_500; timestamp += 20) {
      quality.observeFrame(timestamp);
    }
    for (let timestamp = 1_516; timestamp <= 3_020; timestamp += 16) {
      quality.observeFrame(timestamp);
    }

    expect(quality.profile).toEqual(QUALITY_PROFILES.limited);
  });
});
