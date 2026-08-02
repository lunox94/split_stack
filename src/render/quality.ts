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
const MISSED_BUDGET_WINDOW_MS = 5_000;

export class QualityController {
  readonly #onChange: ((profile: RenderQualityProfile) => void) | undefined;
  #quality: EffectQuality;
  #lastObservedAt: number | null = null;
  #windowStartedAt: number | null = null;
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

  observeFrame(timestampMs: number): void {
    if (this.#quality !== "full") {
      this.#lastObservedAt = timestampMs;
      return;
    }
    if (this.#lastObservedAt === null) {
      this.#lastObservedAt = timestampMs;
      this.#windowStartedAt = timestampMs;
      return;
    }

    const delta = Math.max(0, Math.min(250, timestampMs - this.#lastObservedAt));
    this.#lastObservedAt = timestampMs;
    this.#windowStartedAt ??= timestampMs;
    this.#windowFrameTime += delta;
    this.#windowFrames += 1;

    if (timestampMs - this.#windowStartedAt < MISSED_BUDGET_WINDOW_MS) return;
    const average = this.#windowFrameTime / Math.max(1, this.#windowFrames);
    if (average > FRAME_BUDGET_MS * 1.12) {
      this.set("limited");
      return;
    }
    this.#windowStartedAt = timestampMs;
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
    this.#windowStartedAt = null;
    this.#windowFrameTime = 0;
    this.#windowFrames = 0;
    this.#lastRenderedAt = null;
  }
}
