import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences,
  type StoragePort,
} from "../../src/persistence/settings";

class MemoryStorage implements StoragePort {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("local preferences", () => {
  it("keeps music and effects independently controllable", () => {
    const storage = new MemoryStorage();
    savePreferences(storage, {
      ...DEFAULT_PREFERENCES,
      effectsEnabled: false,
      effectsVolume: 0.25,
      musicEnabled: true,
      musicVolume: 0.6,
    });

    expect(loadPreferences(storage, false)).toMatchObject({
      effectsEnabled: false,
      effectsVolume: 0.25,
      musicEnabled: true,
      musicVolume: 0.6,
    });
  });

  it("defaults tips off and respects first-run reduced-motion", () => {
    expect(loadPreferences(new MemoryStorage(), true)).toMatchObject({
      gameplayTips: false,
      reducedMotion: true,
      reducedEffects: true,
    });
  });

  it("round-trips bounded settings and ignores malformed cache data", () => {
    const storage = new MemoryStorage();
    savePreferences(storage, {
      ...DEFAULT_PREFERENCES,
      effectsVolume: 0.35,
      touchControls: "buttons",
      colorPalette: "colorblind",
    });

    expect(loadPreferences(storage, false)).toMatchObject({
      effectsVolume: 0.35,
      touchControls: "buttons",
      colorPalette: "colorblind",
    });
    storage.setItem("split-stack/preferences/v1", "not json");
    expect(loadPreferences(storage, false)).toEqual(DEFAULT_PREFERENCES);
  });

  it("migrates the former single audio control to both audio buses", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "split-stack/preferences/v1",
      JSON.stringify({ audioEnabled: false, volume: 0.3 }),
    );

    expect(loadPreferences(storage, false)).toMatchObject({
      effectsEnabled: false,
      effectsVolume: 0.3,
      musicEnabled: false,
      musicVolume: 0.3,
    });
  });
});
