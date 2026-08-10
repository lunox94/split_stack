import { QUALITY_PROFILES, type EffectQuality } from "../render/quality";

export type GraphicsSetting = "auto" | "normal" | "low" | "very-low";
export type GraphicsTier = Exclude<GraphicsSetting, "auto">;

export interface GraphicsPlanInput {
  readonly setting: GraphicsSetting;
  readonly autoTier: GraphicsTier;
  readonly reducedMotion?: boolean;
  readonly reducedFlashes?: boolean;
  readonly screenShake?: boolean;
}

export interface GraphicsPlan {
  readonly tier: GraphicsTier;
  readonly renderQuality: EffectQuality;
  readonly targetFps: 60 | 30;
  readonly maxPixelRatio: number;
  readonly particleScale: number;
  readonly allowScreenShake: boolean;
  readonly reducedMotion: boolean;
  readonly reducedFlashes: boolean;
  readonly staticLegibilityCues: boolean;
}

const QUALITY_FOR_TIER: Record<GraphicsTier, EffectQuality> = {
  normal: "full",
  low: "limited",
  "very-low": "reduced",
};

export function resolveGraphicsPlan(input: GraphicsPlanInput): GraphicsPlan {
  const tier = input.setting === "auto" ? input.autoTier : input.setting;
  const profile = QUALITY_PROFILES[QUALITY_FOR_TIER[tier]];
  const reducedMotion = input.reducedMotion ?? false;
  const reducedFlashes = input.reducedFlashes ?? false;
  return {
    tier,
    renderQuality: profile.effects,
    targetFps: profile.targetFps,
    maxPixelRatio: profile.maxPixelRatio,
    particleScale: reducedMotion ? 0 : profile.particleScale,
    allowScreenShake: !reducedMotion && (input.screenShake ?? true) && profile.screenShake,
    reducedMotion,
    reducedFlashes,
    staticLegibilityCues: reducedMotion || reducedFlashes,
  };
}

const CALIBRATION_SAMPLES = 24;
const MIN_SAMPLE_MS = 4;
const MAX_SAMPLE_MS = 50;
const MIN_BASELINE_MS = 1_000 / 60;
const MAX_BASELINE_MS = 1_000 / 50;
const WINDOW_MS = 2_000;
const DOWNGRADE_RATIO = 1.2;
const DOWNGRADE_INTERVAL_MS = 2_000;
const RECOVERY_COOLDOWN_MS = 10_000;
const HEALTHY_RATIO = 1.08;
const HEALTHY_REQUIRED_MS = 8_000;
const TIERS: readonly GraphicsTier[] = ["normal", "low", "very-low"];

export class GraphicsAutoController {
  #tier: GraphicsTier = "normal";
  #lastTimestamp: number | null = null;
  #calibration: number[] = [];
  #baselineMs: number | null = null;
  #windowElapsedMs = 0;
  #windowFrameTotalMs = 0;
  #windowFrames = 0;
  #lastDowngradeAt: number | null = null;
  #recoveryCooldownUntil = 0;
  #awaitingResume = false;
  #healthyMs = 0;

  get tier(): GraphicsTier {
    return this.#tier;
  }

  observeFrame(timestampMs: number): void {
    if (!Number.isFinite(timestampMs)) {
      this.#clearSampling();
      return;
    }
    if (this.#lastTimestamp === null) {
      this.#lastTimestamp = timestampMs;
      if (this.#awaitingResume) {
        this.#recoveryCooldownUntil = timestampMs + RECOVERY_COOLDOWN_MS;
        this.#awaitingResume = false;
      }
      return;
    }
    if (timestampMs <= this.#lastTimestamp) {
      this.#clearSampling();
      return;
    }
    const delta = timestampMs - this.#lastTimestamp;
    this.#lastTimestamp = timestampMs;
    if (delta >= 250) {
      this.#downgrade(timestampMs);
      this.#clearWindow();
      return;
    }
    if (this.#baselineMs === null) {
      if (delta >= MIN_SAMPLE_MS && delta <= MAX_SAMPLE_MS) this.#calibration.push(delta);
      if (this.#calibration.length === CALIBRATION_SAMPLES) {
        const sorted = [...this.#calibration].sort((a, b) => a - b);
        this.#baselineMs = Math.max(
          MIN_BASELINE_MS,
          Math.min(MAX_BASELINE_MS, (sorted[11]! + sorted[12]!) / 2),
        );
        this.#clearWindow();
      }
      return;
    }
    this.#windowElapsedMs += delta;
    this.#windowFrameTotalMs += delta;
    this.#windowFrames += 1;
    if (this.#windowElapsedMs < WINDOW_MS) return;
    const ratio = this.#windowFrameTotalMs / this.#windowFrames / this.#baselineMs;
    if (ratio >= DOWNGRADE_RATIO) {
      this.#downgrade(timestampMs);
      this.#healthyMs = 0;
    } else if (this.#tier !== "normal" && timestampMs >= this.#recoveryCooldownUntil && ratio <= HEALTHY_RATIO) {
      this.#healthyMs += this.#windowElapsedMs;
      if (this.#healthyMs >= HEALTHY_REQUIRED_MS) this.#upgrade(timestampMs);
    } else if (ratio > HEALTHY_RATIO) {
      this.#healthyMs = 0;
    }
    this.#clearWindow();
  }

  noteSuspension(): void {
    this.#clearSampling();
    this.#awaitingResume = true;
  }

  reset(): void {
    this.#tier = "normal";
    this.#lastTimestamp = null;
    this.#calibration = [];
    this.#baselineMs = null;
    this.#clearWindow();
    this.#lastDowngradeAt = null;
    this.#recoveryCooldownUntil = 0;
    this.#awaitingResume = false;
    this.#healthyMs = 0;
  }

  #downgrade(timestampMs: number): void {
    if (this.#lastDowngradeAt !== null && timestampMs - this.#lastDowngradeAt < DOWNGRADE_INTERVAL_MS) return;
    const next = TIERS.indexOf(this.#tier) + 1;
    if (next >= TIERS.length) return;
    this.#tier = TIERS[next]!;
    this.#lastDowngradeAt = timestampMs;
    this.#recoveryCooldownUntil = timestampMs + RECOVERY_COOLDOWN_MS;
    this.#healthyMs = 0;
  }

  #upgrade(timestampMs: number): void {
    const previous = TIERS.indexOf(this.#tier) - 1;
    if (previous < 0) return;
    this.#tier = TIERS[previous]!;
    this.#recoveryCooldownUntil = timestampMs + RECOVERY_COOLDOWN_MS;
    this.#healthyMs = 0;
  }

  #clearSampling(): void {
    this.#lastTimestamp = null;
    this.#calibration = [];
    this.#baselineMs = null;
    this.#clearWindow();
    this.#healthyMs = 0;
    this.#awaitingResume = false;
  }

  #clearWindow(): void {
    this.#windowElapsedMs = 0;
    this.#windowFrameTotalMs = 0;
    this.#windowFrames = 0;
  }
}
