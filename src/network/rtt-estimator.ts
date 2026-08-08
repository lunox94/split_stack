export interface RoundTripEstimate {
  readonly smoothedMs: number;
  readonly variationMs: number;
}

/** Constant-space RFC 6298-style smoothing shared by transport policies. */
export class RoundTripEstimator {
  private smoothedMs: number | null = null;
  private variationMs: number | null = null;

  public observe(milliseconds: number): RoundTripEstimate {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError("Round-trip samples must be finite and non-negative");
    }
    if (this.smoothedMs === null || this.variationMs === null) {
      this.smoothedMs = milliseconds;
      this.variationMs = milliseconds / 2;
    } else {
      this.variationMs =
        this.variationMs * 0.75 +
        Math.abs(this.smoothedMs - milliseconds) * 0.25;
      this.smoothedMs = this.smoothedMs * 0.875 + milliseconds * 0.125;
    }
    return this.current()!;
  }

  public current(): RoundTripEstimate | null {
    return this.smoothedMs === null || this.variationMs === null
      ? null
      : {
          smoothedMs: this.smoothedMs,
          variationMs: this.variationMs,
        };
  }
}
