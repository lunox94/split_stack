// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { updateHud } from "../../src/app/bootstrap";
import type { PlayerSnapshotV1 } from "../../src/network/snapshots";
import { SPECIAL_ICON_PATHS } from "../../src/render/special-icons";
import { createAppShell } from "../../src/ui/shell";

const PREVIEW_OPTIONS = {
  colorPalette: "standard",
  reducedMotion: false,
  reducedFlashes: false,
  elapsedMs: 0,
} as const;

function snapshot(
  statuses: PlayerSnapshotV1["statuses"],
): PlayerSnapshotV1 {
  return {
    score: 0,
    level: 1,
    lines: 0,
    stateTick: 0,
    powerCharge: 0,
    powerDeckCursor: 0,
    upcomingPower: "nuke",
    statuses,
    incomingGarbage: [],
    hold: null,
    nextFive: [],
    replacementMode: null,
  } as unknown as PlayerSnapshotV1;
}

describe("board status presentation", () => {
  it("marks only the affected board as Scrambled for every rendered viewpoint", () => {
    const shell = createAppShell(document, document.createElement("div"));

    updateHud(
      shell.left,
      "Player A",
      snapshot([{ kind: "scramble", remainingTicks: 500 }]),
      PREVIEW_OPTIONS,
    );
    updateHud(shell.right, "Player B", snapshot([]), PREVIEW_OPTIONS);

    expect(shell.left.pane.dataset.scrambled).toBe("true");
    expect(shell.right.pane.dataset.scrambled).toBe("false");

    updateHud(shell.left, "Player A", snapshot([]), PREVIEW_OPTIONS);
    updateHud(
      shell.right,
      "Player B",
      snapshot([{ kind: "scramble", remainingTicks: 480 }]),
      PREVIEW_OPTIONS,
    );

    expect(shell.left.pane.dataset.scrambled).toBe("false");
    expect(shell.right.pane.dataset.scrambled).toBe("true");
  });

  it("uses the canonical Blackout icon while preserving the cover's accessible name", () => {
    const shell = createAppShell(document, document.createElement("div"));
    const cover = shell.right.blackout;
    const icon = cover.querySelector<SVGSVGElement>(
      '[data-special-icon="blackout"]',
    );

    expect(cover.getAttribute("role")).toBe("img");
    expect(cover.getAttribute("aria-label")).toBe("Board concealed by Blackout");
    expect(cover.childNodes).toHaveLength(1);
    expect(icon?.classList).toContain("blackout-icon");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.hasAttribute("role")).toBe(false);
    expect(icon?.querySelector("path")?.getAttribute("d")).toBe(
      SPECIAL_ICON_PATHS.blackout,
    );
  });
});
