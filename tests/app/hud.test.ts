// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { updateHud } from "../../src/app/bootstrap";
import type { PlayerSnapshot } from "../../src/network/snapshots";
import { createAppShell } from "../../src/ui/shell";

const PREVIEW_OPTIONS = {
  colorPalette: "standard",
  reducedMotion: false,
  reducedFlashes: false,
  elapsedMs: 0,
} as const;

function snapshot(overrides: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    score: 120,
    level: 2,
    lines: 3,
    stateTick: 120,
    powerCharge: 4,
    powerDeckCursor: 0,
    upcomingPower: "nuke",
    statuses: [{ kind: "blackout", remainingTicks: 120 }],
    incomingGarbage: [{ id: "garbage-1", rows: 2, hole: 4, readyTick: 180 }],
    hold: { source: "base", shape: "T" },
    nextFive: [{ source: "base", shape: "I" }],
    replacementMode: null,
    ...overrides,
  } as PlayerSnapshot;
}

describe("HUD rendering", () => {
  it("does not rewrite unchanged DOM state on repeated frames", () => {
    const shell = createAppShell(document, document.createElement("div"));
    const current = snapshot();
    updateHud(shell.left, "Player A", current, PREVIEW_OPTIONS);

    const scoreText = vi.spyOn(shell.left.score, "textContent", "set");
    const levelText = vi.spyOn(shell.left.level, "textContent", "set");
    const statusChildren = vi.spyOn(shell.left.statuses, "replaceChildren");
    const meterSegment = vi.spyOn(shell.left.meterSegments[0]!.classList, "toggle");
    const meterAccessibility = vi.spyOn(shell.left.meter, "setAttribute");
    const barrierSegment = vi.spyOn(
      shell.left.barrierCapacitySegments[0]!.classList,
      "toggle",
    );
    const barrierAccessibility = vi.spyOn(
      shell.left.barrierCapacity,
      "setAttribute",
    );
    const previewGrid = shell.left.preview.querySelector(".piece-preview-grid");

    updateHud(shell.left, "Player A", current, PREVIEW_OPTIONS);

    expect(scoreText).not.toHaveBeenCalled();
    expect(levelText).not.toHaveBeenCalled();
    expect(statusChildren).not.toHaveBeenCalled();
    expect(meterSegment).not.toHaveBeenCalled();
    expect(meterAccessibility).not.toHaveBeenCalled();
    expect(barrierSegment).not.toHaveBeenCalled();
    expect(barrierAccessibility).not.toHaveBeenCalled();
    expect(shell.left.preview.querySelector(".piece-preview-grid")).toBe(previewGrid);
  });

  it("updates the cached fields when their presentation changes", () => {
    const shell = createAppShell(document, document.createElement("div"));
    updateHud(shell.left, "Player A", snapshot(), PREVIEW_OPTIONS);

    updateHud(
      shell.left,
      "Player A",
      snapshot({
        score: 240,
        powerCharge: 7,
        statuses: [{ kind: "barrier", remainingTicks: 60, capacity: 2 }],
      }),
      PREVIEW_OPTIONS,
    );

    expect(shell.left.score.textContent).toBe("240");
    expect(
      shell.left.meterSegments.filter((segment) =>
        segment.classList.contains("is-filled")
      ),
    ).toHaveLength(7);
    expect(shell.left.meter.getAttribute("aria-valuenow")).toBe("7");
    expect(shell.left.statuses.textContent).toContain("Barrier");
    expect(shell.left.statuses.textContent).not.toContain("Barrier 2");
    expect(
      shell.left.barrierCapacitySegments.filter((segment) =>
        segment.classList.contains("is-filled")
      ),
    ).toHaveLength(2);
    expect(shell.left.barrierCapacity.getAttribute("aria-valuenow")).toBe("2");
  });

  it("keeps the neutral Barrier channel visible and hides a spent Barrier timer", () => {
    const shell = createAppShell(document, document.createElement("div"));

    updateHud(
      shell.left,
      "Player A",
      snapshot({
        statuses: [{ kind: "barrier", remainingTicks: 60, capacity: 0 }],
      }),
      PREVIEW_OPTIONS,
    );

    expect(shell.left.barrierCapacity.hidden).toBe(false);
    expect(shell.left.barrierCapacitySegments).toHaveLength(4);
    expect(
      shell.left.barrierCapacitySegments.some((segment) =>
        segment.classList.contains("is-filled")
      ),
    ).toBe(false);
    expect(shell.left.statuses.textContent).not.toContain("Barrier");
  });

  it("steps Barrier capacity right-to-left without inferring presentation events", () => {
    const shell = createAppShell(document, document.createElement("div"));
    updateHud(
      shell.left,
      "Player A",
      snapshot({
        statuses: [{ kind: "barrier", remainingTicks: 1_200, capacity: 4 }],
      }),
      PREVIEW_OPTIONS,
    );
    expect(
      shell.left.barrierCapacitySegments.map((segment) =>
        segment.style.getPropertyValue("--barrier-step-delay")
      ),
    ).toEqual(["0ms", "55ms", "110ms", "165ms"]);

    updateHud(
      shell.left,
      "Player A",
      snapshot({
        statuses: [{ kind: "barrier", remainingTicks: 1_190, capacity: 1 }],
      }),
      PREVIEW_OPTIONS,
    );

    expect(
      shell.left.barrierCapacitySegments.map((segment) => ({
        filled: segment.classList.contains("is-filled"),
        delay: segment.style.getPropertyValue("--barrier-step-delay"),
      })),
    ).toEqual([
      { filled: true, delay: "0ms" },
      { filled: false, delay: "110ms" },
      { filled: false, delay: "55ms" },
      { filled: false, delay: "0ms" },
    ]);
  });

  it("still advances an animated Glitch preview when its visual frame changes", () => {
    const shell = createAppShell(document, document.createElement("div"));
    const glitch = snapshot({
      nextFive: [{
        source: "glitch",
        shape: "Z",
        previewCosmetics: {
          kind: "glitch-cycle",
          shapes: ["I", "J", "L", "O", "S", "T", "Z"],
          intervalMs: 150,
          finalShapeConcealed: true,
        },
      }],
    });

    updateHud(shell.left, "Player A", glitch, PREVIEW_OPTIONS);
    const primary = shell.left.preview.querySelector<HTMLElement>(
      ".piece-preview-slot.is-primary",
    );
    expect(primary?.dataset.displayShape).toBe("I");

    updateHud(shell.left, "Player A", glitch, {
      ...PREVIEW_OPTIONS,
      elapsedMs: 150,
    });

    expect(primary?.dataset.displayShape).toBe("J");
  });

  it("shows Acid Rain as three Next drops instead of a timed status row", () => {
    const shell = createAppShell(document, document.createElement("div"));
    updateHud(
      shell.left,
      "Player A",
      snapshot({
        statuses: [],
        replacementMode: { kind: "acid-rain", remainingPieces: 3 },
        nextFive: [
          { source: "acid", shape: "acid" },
          { source: "acid", shape: "acid" },
          { source: "acid", shape: "acid" },
          { source: "base", shape: "I" },
          { source: "base", shape: "T" },
        ],
      }),
      PREVIEW_OPTIONS,
    );

    expect(
      shell.left.preview.querySelectorAll('[data-source="acid"]'),
    ).toHaveLength(3);
    expect(shell.left.statuses.textContent).not.toContain("Acid Rain");
  });

  it("shows Monomino Rush in the timed-effect rows", () => {
    const shell = createAppShell(document, document.createElement("div"));
    updateHud(
      shell.left,
      "Player A",
      snapshot({
        statuses: [],
        replacementMode: { kind: "monomino-rush", remainingTicks: 180 },
      }),
      PREVIEW_OPTIONS,
    );

    expect(shell.left.statuses.textContent).toContain("Monomino Rush");
    expect(shell.left.statuses.textContent).toContain("3s");
  });

  it("orders Monomino Rush with statuses by activation age before queuing visuals", () => {
    const shell = createAppShell(document, document.createElement("div"));
    updateHud(
      shell.left,
      "Player A",
      snapshot({
        statuses: [
          { kind: "blackout", remainingTicks: 700 },
          { kind: "scramble", remainingTicks: 500 },
          { kind: "ghost-jam", remainingTicks: 850 },
          { kind: "barrier", remainingTicks: 1_190, capacity: 3 },
        ],
        replacementMode: { kind: "monomino-rush", remainingTicks: 180 },
      }),
      PREVIEW_OPTIONS,
    );

    expect(
      [...shell.left.statuses.querySelectorAll<HTMLElement>(".timed-effect")]
        .map((row) => row.dataset.effect),
    ).toEqual(["monomino-rush", "blackout", "scramble", "ghost-jam"]);
    expect(shell.left.statuses.dataset.queuedEffects).toBe("1");
  });
});
