export type EffectQuality = "full" | "limited" | "reduced";

export interface RenderQualityProfile {
  readonly effects: EffectQuality;
  readonly targetFps: 60 | 30;
  readonly maxPixelRatio: number;
  readonly particleScale: number;
  readonly screenShake: boolean;
}

export const QUALITY_PROFILES = {
  full: { effects: "full", targetFps: 60, maxPixelRatio: 1.5, particleScale: 1, screenShake: true },
  limited: { effects: "limited", targetFps: 60, maxPixelRatio: 1.25, particleScale: 0.45, screenShake: false },
  reduced: { effects: "reduced", targetFps: 30, maxPixelRatio: 1, particleScale: 0, screenShake: false },
} as const satisfies Record<EffectQuality, RenderQualityProfile>;

export interface QualityControllerOptions {
  readonly initial?: EffectQuality;
  readonly onChange?: (profile: RenderQualityProfile) => void;
}

export class QualityController {
  readonly #onChange: ((profile: RenderQualityProfile) => void) | undefined;
  #quality: EffectQuality;
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
    this.#lastRenderedAt = null;
    this.#onChange?.(this.profile);
  }

  noteSuspension(): void {
    this.#lastRenderedAt = null;
  }

  shouldRender(timestampMs: number): boolean {
    const interval = 1_000 / this.profile.targetFps;
    if (this.#lastRenderedAt !== null && timestampMs - this.#lastRenderedAt < interval * 0.9) {
      return false;
    }
    this.#lastRenderedAt = timestampMs;
    return true;
  }
}
