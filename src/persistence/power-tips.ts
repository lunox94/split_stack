import { RULES } from "../config/rules";
import type { PowerKind } from "../domain/types";

export interface PowerTipStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PowerTipTracker {
  shouldShow(power: PowerKind): boolean;
  markShown(power: PowerKind): void;
}

export const POWER_TIPS_STORAGE_KEY = "split-stack/power-tips/v1";

function isPowerKind(value: unknown): value is PowerKind {
  return typeof value === "string" && RULES.power.deck.includes(value as PowerKind);
}

export function createPowerTipTracker(storage: PowerTipStorage): PowerTipTracker {
  let seen = new Set<PowerKind>();
  try {
    const stored = storage.getItem(POWER_TIPS_STORAGE_KEY);
    if (stored !== null) {
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed)) {
        seen = new Set(parsed.filter(isPowerKind));
      }
    }
  } catch {
    seen = new Set();
  }

  return {
    shouldShow(power) {
      return !seen.has(power);
    },
    markShown(power) {
      seen.add(power);
      try {
        storage.setItem(POWER_TIPS_STORAGE_KEY, JSON.stringify([...seen]));
      } catch {
        // Tips are a cache; keep the current session usable without storage.
      }
    },
  };
}
