export type EffectQuality = "full" | "limited" | "reduced";

export interface RenderQualityProfile {
  readonly effects: EffectQuality;
  readonly targetFps: 60 | 30;
  readonly maxPixelRatio: number;
  readonly particleScale: number;
  readonly screenShake: boolean;
}

export const QUALITY_PROFILES = {
  full: {
    effects: "full",
    targetFps: 60,
    maxPixelRatio: 1.5,
    particleScale: 1,
    screenShake: true,
  },
  limited: {
    effects: "limited",
    targetFps: 60,
    maxPixelRatio: 1.25,
    particleScale: 0.45,
    screenShake: false,
  },
  reduced: {
    effects: "reduced",
    targetFps: 30,
    maxPixelRatio: 1,
    particleScale: 0,
    screenShake: false,
  },
} as const satisfies Record<EffectQuality, RenderQualityProfile>;

export interface QualityControllerOptions {
  readonly initial?: EffectQuality;
  readonly onChange?: (profile: RenderQualityProfile) => void;
}

const FRAME_BUDGET_MS = 1_000 / 60;
const MISSED_BUDGET_WINDOW_MS = 1_500;
const MAX_SAMPLED_FRAME_MS = 50;

export class QualityController {
  readonly #onChange: ((profile: RenderQualityProfile) => void) | undefined;
  #quality: EffectQuality;
  #lastObservedAt: number | null = null;
  #windowElapsedMs = 0;
  #windowFrameTime = 0;
  #windowFrames = 0;
  #lastRenderedAt: number | null = null;

  constructor(options: QualityControllerOptions = {}) {
    this.#quality = options.initial ?? "full";
    this.#onChange = options.onChange;
  }

  get profile(): RenderQualityProfile {
    return QUALITY_PROFILES[this.#quality];
  }

  set(quality: EffectQuality): void {
    if (quality === this.#quality) return;
    this.#quality = quality;
    this.#resetMeasurement();
    this.#onChange?.(this.profile);
  }

  setReducedEffects(reduced: boolean): void {
    this.set(reduced ? "reduced" : "full");
  }

  noteSuspension(): void {
    this.#resetMeasurement();
  }

  observeFrame(
    timestampMs: number,
    observedTargetFps: 60 | 30 = this.profile.targetFps,
  ): void {
    if (this.#quality === "reduced") {
      this.#lastObservedAt = timestampMs;
      return;
    }
    if (this.#lastObservedAt === null) {
      this.#lastObservedAt = timestampMs;
      return;
    }

    const rawDelta = Math.max(0, timestampMs - this.#lastObservedAt);
    this.#lastObservedAt = timestampMs;
    this.#windowElapsedMs += rawDelta;
    this.#windowFrameTime += Math.min(MAX_SAMPLED_FRAME_MS, rawDelta);
    this.#windowFrames += 1;

    if (this.#windowElapsedMs < MISSED_BUDGET_WINDOW_MS) return;
    const average = this.#windowFrameTime / Math.max(1, this.#windowFrames);
    const observedFrameBudgetMs = observedTargetFps === 60
      ? FRAME_BUDGET_MS
      : 1_000 / observedTargetFps;
    if (average > observedFrameBudgetMs * 1.12) {
      this.set(this.#quality === "full" ? "limited" : "reduced");
      return;
    }
    this.#windowElapsedMs = 0;
    this.#windowFrameTime = 0;
    this.#windowFrames = 0;
  }

  shouldRender(timestampMs: number): boolean {
    const interval = 1_000 / this.profile.targetFps;
    if (
      this.#lastRenderedAt !== null &&
      timestampMs - this.#lastRenderedAt < interval * 0.9
    ) {
      return false;
    }
    this.#lastRenderedAt = timestampMs;
    return true;
  }

  #resetMeasurement(): void {
    this.#lastObservedAt = null;
    this.#windowElapsedMs = 0;
    this.#windowFrameTime = 0;
    this.#windowFrames = 0;
    this.#lastRenderedAt = null;
  }
}
