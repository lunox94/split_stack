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
  it("keeps music, effects, and callouts independently controllable", () => {
    const storage = new MemoryStorage();
    savePreferences(storage, {
      ...DEFAULT_PREFERENCES,
      effectsEnabled: false,
      effectsVolume: 0.25,
      musicEnabled: true,
      musicVolume: 0.6,
      calloutsEnabled: false,
      calloutsVolume: 0.45,
    });

    expect(loadPreferences(storage, false)).toMatchObject({
      effectsEnabled: false,
      effectsVolume: 0.25,
      musicEnabled: true,
      musicVolume: 0.6,
      calloutsEnabled: false,
      calloutsVolume: 0.45,
    });
  });

  it("starts with music as a background bed under crisp effects and callouts", () => {
    expect(loadPreferences(new MemoryStorage(), false)).toMatchObject({
      effectsEnabled: true,
      effectsVolume: 0.85,
      musicEnabled: true,
      musicVolume: 0.45,
      calloutsEnabled: true,
      calloutsVolume: 0.85,
      debugTools: false,
    });
  });

  it("persists Debug tools as an opt-in local preference", () => {
    const storage = new MemoryStorage();
    savePreferences(storage, { ...DEFAULT_PREFERENCES, debugTools: true });

    expect(loadPreferences(storage, false).debugTools).toBe(true);
  });

  it("defaults graphics to Auto without letting first-run media preferences change it", () => {
    expect(loadPreferences(new MemoryStorage(), true)).toMatchObject({
      gameplayTips: false,
      reducedMotion: true,
      graphics: "auto",
    });
  });

  it("migrates legacy reducedEffects only when graphics is absent or invalid", () => {
    const storage = new MemoryStorage();
    storage.setItem("split-stack/preferences/v1", JSON.stringify({ reducedEffects: true }));
    expect(loadPreferences(storage, false).graphics).toBe("very-low");
    storage.setItem("split-stack/preferences/v1", JSON.stringify({
      graphics: "low", reducedEffects: true, screenShake: false,
    }));
    expect(loadPreferences(storage, false)).toMatchObject({ graphics: "low", screenShake: false });
    storage.setItem("split-stack/preferences/v1", JSON.stringify({ graphics: "unknown" }));
    expect(loadPreferences(storage, false).graphics).toBe("auto");
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
      graphics: "auto",
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
