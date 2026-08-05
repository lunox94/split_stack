import { describe, expect, it } from "vitest";

import { parseSnapshotProfile } from "../../src/network/snapshot-profile";

describe("snapshot transport profile", () => {
  it("defaults an unset build variable to the production 10 Hz profile", () => {
    expect(parseSnapshotProfile(undefined)).toEqual({
      hz: 10,
      intervalTicks: 6,
    });
  });

  it("maps each supported experiment rate to simulation ticks", () => {
    expect(["10", "5", "2", "0"].map(parseSnapshotProfile)).toEqual([
      { hz: 10, intervalTicks: 6 },
      { hz: 5, intervalTicks: 12 },
      { hz: 2, intervalTicks: 30 },
      { hz: 0, intervalTicks: null },
    ]);
  });

  it("rejects a misspelled experiment profile instead of silently mislabelling a build", () => {
    expect(() => parseSnapshotProfile("4")).toThrow(
      "VITE_SPLIT_STACK_SNAPSHOT_HZ must be one of 10, 5, 2, or 0",
    );
  });
});
