import { describe, expect, it } from "vitest";

import {
  POWER_TIPS_STORAGE_KEY,
  createPowerTipTracker,
  type PowerTipStorage,
} from "../../src/persistence/power-tips";

class MemoryStorage implements PowerTipStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class UnavailableStorage implements PowerTipStorage {
  getItem(): string | null {
    throw new Error("storage unavailable");
  }

  setItem(): void {
    throw new Error("storage unavailable");
  }
}

describe("gameplay power tips", () => {
  it("shows an upcoming local power only until it is marked across sessions", () => {
    const storage = new MemoryStorage();
    const tracker = createPowerTipTracker(storage);

    expect(tracker.shouldShow("nuke")).toBe(true);

    tracker.markShown("nuke");

    expect(tracker.shouldShow("nuke")).toBe(false);
    expect(createPowerTipTracker(storage).shouldShow("nuke")).toBe(false);
    expect(storage.values.has(POWER_TIPS_STORAGE_KEY)).toBe(true);
  });

  it("treats malformed stored data as an empty seen set", () => {
    const storage = new MemoryStorage();
    storage.setItem(POWER_TIPS_STORAGE_KEY, "not json");

    expect(createPowerTipTracker(storage).shouldShow("collapse")).toBe(true);
  });

  it("continues tracking for the session when storage is unavailable", () => {
    const tracker = createPowerTipTracker(new UnavailableStorage());

    expect(tracker.shouldShow("ghost-jam")).toBe(true);
    expect(() => tracker.markShown("ghost-jam")).not.toThrow();
    expect(tracker.shouldShow("ghost-jam")).toBe(false);
  });

  it("keeps only recognized power kinds from stored data", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      POWER_TIPS_STORAGE_KEY,
      JSON.stringify(["nuke", "future-power", 42, "nuke"]),
    );
    const tracker = createPowerTipTracker(storage);

    expect(tracker.shouldShow("nuke")).toBe(false);
    expect(tracker.shouldShow("collapse")).toBe(true);

    tracker.markShown("collapse");

    expect(JSON.parse(storage.values.get(POWER_TIPS_STORAGE_KEY) ?? "null")).toEqual([
      "nuke",
      "collapse",
    ]);
  });
});
