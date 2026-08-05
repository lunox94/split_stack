import type { AppRuntimeMode } from "./runtime-helpers";

export const NETWORKED_PRESENTATION_FPS = 30;

/**
 * Caps only presentation work for networked modes. Their simulation and
 * transport advance in the independent competitive pump, so a skipped visual
 * frame cannot drop input or delay network reconciliation.
 */
export class RuntimePresentationCadence {
  #lastNetworkedPresentationAt: number | null = null;

  shouldPresent(mode: AppRuntimeMode, timestampMs: number): boolean {
    if (mode !== "competitive" && mode !== "spectator") {
      this.#lastNetworkedPresentationAt = null;
      return true;
    }

    const interval = 1_000 / NETWORKED_PRESENTATION_FPS;
    if (
      this.#lastNetworkedPresentationAt !== null &&
      timestampMs - this.#lastNetworkedPresentationAt < interval * 0.9
    ) {
      return false;
    }
    this.#lastNetworkedPresentationAt = timestampMs;
    return true;
  }
}
