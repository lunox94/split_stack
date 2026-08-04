export interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Preferences {
  effectsEnabled: boolean;
  effectsVolume: number;
  musicEnabled: boolean;
  musicVolume: number;
  vibration: boolean;
  touchControls: "gestures" | "buttons";
  colorPalette: "standard" | "colorblind";
  reducedMotion: boolean;
  reducedFlashes: boolean;
  reducedEffects: boolean;
  screenShake: boolean;
  gameplayTips: boolean;
}

const STORAGE_KEY = "split-stack/preferences/v1";

export const DEFAULT_PREFERENCES: Preferences = {
  effectsEnabled: true,
  effectsVolume: 0.8,
  musicEnabled: true,
  musicVolume: 0.55,
  vibration: true,
  touchControls: "gestures",
  colorPalette: "standard",
  reducedMotion: false,
  reducedFlashes: false,
  reducedEffects: false,
  screenShake: true,
  gameplayTips: false,
};

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function volume(value: unknown, fallback: number): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(1, raw));
}

function parsePreferences(value: unknown, firstRunReducedMotion: boolean): Preferences {
  const record = typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
  const reducedMotion = boolean(record.reducedMotion, firstRunReducedMotion);
  const legacyEnabled = boolean(record.audioEnabled, true);
  const legacyVolume = typeof record.volume === "number" && Number.isFinite(record.volume)
    ? volume(record.volume, DEFAULT_PREFERENCES.effectsVolume)
    : undefined;
  return {
    effectsEnabled: boolean(record.effectsEnabled, legacyEnabled),
    effectsVolume: volume(
      record.effectsVolume,
      legacyVolume ?? DEFAULT_PREFERENCES.effectsVolume,
    ),
    musicEnabled: boolean(record.musicEnabled, legacyEnabled),
    musicVolume: volume(
      record.musicVolume,
      legacyVolume ?? DEFAULT_PREFERENCES.musicVolume,
    ),
    vibration: boolean(record.vibration, DEFAULT_PREFERENCES.vibration),
    touchControls: record.touchControls === "buttons" ? "buttons" : "gestures",
    colorPalette: record.colorPalette === "colorblind" ? "colorblind" : "standard",
    reducedMotion,
    reducedFlashes: boolean(record.reducedFlashes, reducedMotion),
    reducedEffects: boolean(record.reducedEffects, reducedMotion),
    screenShake: boolean(record.screenShake, !reducedMotion),
    gameplayTips: boolean(record.gameplayTips, false),
  };
}

export function loadPreferences(
  storage: StoragePort,
  firstRunReducedMotion: boolean,
): Preferences {
  try {
    const stored = storage.getItem(STORAGE_KEY);
    if (stored === null) return parsePreferences({}, firstRunReducedMotion);
    return parsePreferences(JSON.parse(stored) as unknown, firstRunReducedMotion);
  } catch {
    return parsePreferences({}, firstRunReducedMotion);
  }
}

export function savePreferences(storage: StoragePort, preferences: Preferences): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(parsePreferences(preferences, false)));
  } catch {
    // Preferences are a cache; gameplay must remain available without storage.
  }
}
