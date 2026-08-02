import { describe, expect, it } from "vitest";
import type { PlayerLiveStats } from "../../src/domain/types";
import {
  createRuntimeId,
  appendBoundedUnique,
  displayShapeAt,
  formatDuration,
  isSameRuntimeRoster,
  resultStats,
} from "../../src/app/runtime-helpers";

describe("runtime helpers", () => {
  it("creates a bounded hexadecimal runtime ID", () => {
    const id = createRuntimeId({
      getRandomValues(target) {
        target.fill(0xab);
        return target;
      },
    });

    expect(id).toBe("abababababababababababababababab");
  });

  it("formats active ticks as a compact clock", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(3_661)).toBe("1:01");
    expect(formatDuration(216_060)).toBe("60:01");
  });

  it("copies live statistics into immutable result statistics", () => {
    const live: PlayerLiveStats = {
      garbageSent: 3,
      powersActivated: 2,
      tetrises: 1,
      tSpinSingles: 4,
      tSpinDoubles: 5,
      tSpinTriples: 6,
      topOutTick: 90,
    };

    const output = resultStats(700, 12, live);
    live.garbageSent = 99;

    expect(output).toEqual({
      score: 700,
      lines: 12,
      garbageSent: 3,
      powersActivated: 2,
      tetrises: 1,
      tSpinSingles: 4,
      tSpinDoubles: 5,
      tSpinTriples: 6,
      topOutTick: 90,
    });
  });

  it("treats an occupant replacement as a different live roster", () => {
    const current = {
      matchId: "challenge:round:1",
      role: "a" as const,
      seatAOccupancyEventId: "seat-a-v1",
      seatBOccupancyEventId: "seat-b-v1",
      seatASessionId: "runtime-a-v1",
      seatBSessionId: "runtime-b-v1",
    };

    expect(isSameRuntimeRoster(current, { ...current })).toBe(true);
    expect(
      isSameRuntimeRoster(current, {
        ...current,
        seatBOccupancyEventId: "seat-b-v2",
      }),
    ).toBe(false);
    expect(
      isSameRuntimeRoster(current, {
        ...current,
        seatBSessionId: "runtime-b-v2",
      }),
    ).toBe(false);
    expect(isSameRuntimeRoster(current, { ...current, role: "spectator" })).toBe(false);
  });

  it("cycles concealed Glitch previews without exposing their predetermined shape", () => {
    const concealed = {
      source: "glitch" as const,
      shape: "I" as const,
      previewCosmetics: {
        kind: "glitch-cycle" as const,
        shapes: ["I", "J", "L", "O", "S", "T", "Z"] as const,
        intervalMs: 150,
        finalShapeConcealed: true as const,
      },
    };

    expect(displayShapeAt(concealed, 0)).toBe("I");
    expect(displayShapeAt(concealed, 150)).toBe("J");
    expect(displayShapeAt(concealed, 900)).toBe("Z");
    expect(displayShapeAt({ source: "base", shape: "T" }, 300)).toBe("T");
  });

  it("deduplicates and bounds untrusted durable event buffers", () => {
    const events: Array<{ eventId: string }> = [];
    expect(appendBoundedUnique(events, { eventId: "a" }, 2)).toBe(true);
    expect(appendBoundedUnique(events, { eventId: "a" }, 2)).toBe(false);
    expect(appendBoundedUnique(events, { eventId: "b" }, 2)).toBe(true);
    expect(appendBoundedUnique(events, { eventId: "c" }, 2)).toBe(false);
    expect(events.map((event) => event.eventId)).toEqual(["a", "b"]);
  });
});
