export interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Preferences {
  audioEnabled: boolean;
  volume: number;
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
  audioEnabled: true,
  volume: 0.8,
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

function parsePreferences(value: unknown, firstRunReducedMotion: boolean): Preferences {
  const record = typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
  const reducedMotion = boolean(record.reducedMotion, firstRunReducedMotion);
  const rawVolume = typeof record.volume === "number" && Number.isFinite(record.volume)
    ? record.volume
    : DEFAULT_PREFERENCES.volume;
  return {
    audioEnabled: boolean(record.audioEnabled, DEFAULT_PREFERENCES.audioEnabled),
    volume: Math.max(0, Math.min(1, rawVolume)),
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
