// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { updateHud } from "../../src/app/bootstrap";
import type { PlayerSnapshotV1 } from "../../src/network/snapshots";
import { createAppShell } from "../../src/ui/shell";

const PREVIEW_OPTIONS = {
  colorPalette: "standard",
  reducedMotion: false,
  reducedFlashes: false,
  elapsedMs: 0,
} as const;

function snapshot(overrides: Partial<PlayerSnapshotV1> = {}): PlayerSnapshotV1 {
  return {
    score: 120,
    level: 2,
    lines: 3,
    powerCharge: 4,
    upcomingPower: "nuke",
    statuses: [{ kind: "blackout", remainingTicks: 120 }],
    incomingGarbage: [{ id: "garbage-1", rows: 2, hole: 4, applyAtTick: 180 }],
    hold: { source: "base", shape: "T" },
    nextFive: [{ source: "base", shape: "I" }],
    replacementMode: null,
    ...overrides,
  } as PlayerSnapshotV1;
}

describe("HUD rendering", () => {
  it("does not rewrite unchanged DOM state on repeated frames", () => {
    const shell = createAppShell(document, document.createElement("div"));
    const current = snapshot();
    updateHud(shell.left, "Player A", current, PREVIEW_OPTIONS);

    const scoreText = vi.spyOn(shell.left.score, "textContent", "set");
    const levelText = vi.spyOn(shell.left.level, "textContent", "set");
    const statusChildren = vi.spyOn(shell.left.statuses, "replaceChildren");
    const meterStyle = vi.spyOn(shell.left.meterFill.style, "setProperty");
    const meterAccessibility = vi.spyOn(shell.left.meter, "setAttribute");
    const previewGrid = shell.left.preview.querySelector(".piece-preview-grid");

    updateHud(shell.left, "Player A", current, PREVIEW_OPTIONS);

    expect(scoreText).not.toHaveBeenCalled();
    expect(levelText).not.toHaveBeenCalled();
    expect(statusChildren).not.toHaveBeenCalled();
    expect(meterStyle).not.toHaveBeenCalled();
    expect(meterAccessibility).not.toHaveBeenCalled();
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
    expect(shell.left.meterFill.style.getPropertyValue("--meter-progress")).toBe("100%");
    expect(shell.left.meter.getAttribute("aria-valuenow")).toBe("7");
    expect(shell.left.statuses.textContent).toContain("Barrier");
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
});
