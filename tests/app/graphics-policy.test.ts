import { describe, expect, it } from "vitest";
import {
  GraphicsAutoController,
  resolveGraphicsPlan,
} from "../../src/app/graphics-policy";

describe("graphics policy", () => {
  it("maps every preset to its quality profile", () => {
    expect(resolveGraphicsPlan({ setting: "normal", autoTier: "very-low" })).toMatchObject({
      tier: "normal", renderQuality: "full", targetFps: 60, maxPixelRatio: 1.5, particleScale: 1,
    });
    expect(resolveGraphicsPlan({ setting: "low", autoTier: "normal" })).toMatchObject({
      tier: "low", renderQuality: "limited", targetFps: 60, maxPixelRatio: 1.25, particleScale: 0.45,
    });
    expect(resolveGraphicsPlan({ setting: "very-low", autoTier: "normal" })).toMatchObject({
      tier: "very-low", renderQuality: "reduced", targetFps: 30, maxPixelRatio: 1, particleScale: 0,
    });
  });

  it("uses Auto tier only in Auto mode", () => {
    expect(resolveGraphicsPlan({ setting: "auto", autoTier: "low" }).tier).toBe("low");
    expect(resolveGraphicsPlan({ setting: "normal", autoTier: "very-low" }).tier).toBe("normal");
  });

  it("applies accessibility overrides", () => {
    expect(resolveGraphicsPlan({
      setting: "normal", autoTier: "normal", reducedMotion: true, screenShake: true,
    })).toMatchObject({ particleScale: 0, allowScreenShake: false, reducedMotion: true, staticLegibilityCues: true });
    expect(resolveGraphicsPlan({
      setting: "low", autoTier: "low", reducedFlashes: true,
    })).toMatchObject({ reducedFlashes: true, staticLegibilityCues: true });
  });

  it.each([1000 / 60, 20, 1000 / 90, 1000 / 120])(
    "keeps a stable tier at %dms after calibration",
    (delta) => {
      const controller = calibratedController(delta);
      const start = delta * 24;
      for (let time = start + delta; time <= start + 5_000; time += delta) {
        controller.observeFrame(time);
      }
      expect(controller.tier).toBe("normal");
    },
  );

  it("clamps a 24ms calibration then steps through Low and Very Low", () => {
    const controller = calibratedController(24);
    for (let time = 600; time <= 2_640; time += 24) controller.observeFrame(time);
    expect(controller.tier).toBe("low");
    for (let time = 2_664; time <= 4_800; time += 24) controller.observeFrame(time);
    expect(controller.tier).toBe("very-low");
  });

  it("downgrades after a sustained slowdown", () => {
    const controller = calibratedController(16);
    for (let time = 400; time <= 2_500; time += 24) controller.observeFrame(time);
    expect(controller.tier).toBe("low");
  });

  it("downgrades immediately for a severe frame", () => {
    const controller = calibratedController(16);
    controller.observeFrame(700);
    expect(controller.tier).toBe("low");
  });

  it("retains tier across suspension and recovers one tier after cooldown and healthy time", () => {
    const controller = calibratedController(16);
    controller.observeFrame(700);
    controller.noteSuspension();
    expect(controller.tier).toBe("low");
    controller.observeFrame(1_000);
    for (let time = 1_016; time <= 20_000; time += 16) controller.observeFrame(time);
    expect(controller.tier).toBe("normal");
  });

  it("honors the exact downgrade interval and recovery cooldown boundaries", () => {
    const beforeBoundary = calibratedController(16);
    beforeBoundary.observeFrame(700);
    beforeBoundary.observeFrame(2_699);
    expect(beforeBoundary.tier).toBe("low");

    const atBoundary = calibratedController(16);
    atBoundary.observeFrame(700);
    atBoundary.observeFrame(2_700);
    expect(atBoundary.tier).toBe("very-low");

    const recovery = calibratedController(16);
    recovery.observeFrame(700);
    for (let time = 716; time <= 16_684; time += 16) recovery.observeFrame(time);
    expect(recovery.tier).toBe("low");
    recovery.observeFrame(16_700);
    expect(recovery.tier).toBe("normal");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 384, 300])(
    "clears sampling on malformed timestamp %s without synthesizing a stall",
    (malformed) => {
      const controller = calibratedController(16);
      controller.observeFrame(malformed);
      controller.observeFrame(1_000);
      controller.observeFrame(1_016);
      expect(controller.tier).toBe("normal");
    },
  );

  it("resets to normal", () => {
    const controller = calibratedController(16);
    controller.observeFrame(700);
    controller.reset();
    expect(controller.tier).toBe("normal");
  });
});

function calibratedController(delta: number): GraphicsAutoController {
  const controller = new GraphicsAutoController();
  for (let frame = 0; frame <= 24; frame += 1) controller.observeFrame(frame * delta);
  return controller;
}
