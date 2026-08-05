// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PREFERENCES } from "../../src/persistence/settings";
import { SPECIAL_ICON_PATHS } from "../../src/render/special-icons";
import {
  createAppShell,
  setElementHidden,
  setPowerMeterAccessibility,
  showHelp,
} from "../../src/ui/shell";

describe("application shell", () => {
  it("presents readiness as a centered state with both players visible", () => {
    const shell = createAppShell(document, document.createElement("div"));

    expect(shell.readyButton.closest(".ready-panel")).not.toBeNull();
    expect(shell.readyButton.textContent).toBe("Ready up");
    expect(shell.readyButton.getAttribute("aria-pressed")).toBe("false");
    expect(shell.localReadyStatus.textContent).toContain("Not ready");
    expect(shell.opponentReadyStatus.textContent).toContain("Not ready");
    expect(shell.cancelReadyButton.hidden).toBe(true);

    shell.setReadiness(true, false);

    expect(shell.readyButton.textContent).toBe("✓ You’re ready");
    expect(shell.readyButton.getAttribute("aria-pressed")).toBe("true");
    expect(shell.localReadyStatus.textContent).toContain("Ready");
    expect(shell.opponentReadyStatus.textContent).toContain("Not ready");
    expect(shell.cancelReadyButton.hidden).toBe(false);

    shell.setOverlayMessage("Match starts in 3");
    expect(shell.readinessPanel.hidden).toBe(true);
    expect(shell.overlayText.hidden).toBe(false);
    expect(shell.overlayText.textContent).toBe("Match starts in 3");
  });

  it("renders Hold and a large-first five-piece queue as real miniatures", () => {
    const shell = createAppShell(document, document.createElement("div"));
    const marked = {
      source: "base",
      shape: "T",
      specialCellIndex: 0,
      specialKind: "glitch-core",
    } as const;
    const glitch = {
      source: "glitch",
      shape: "Z",
      previewCosmetics: {
        kind: "glitch-cycle",
        shapes: ["I", "J", "L", "O", "S", "T", "Z"],
        intervalMs: 150,
        finalShapeConcealed: true,
      },
    } as const;

    shell.left.setPiecePreviews(
      marked,
      [
        glitch,
        { source: "cross", shape: "cross" },
        { source: "oversize", shape: "T" },
        { source: "base", shape: "O" },
        { source: "base", shape: "S" },
      ],
      {
        colorPalette: "standard",
        reducedMotion: false,
        reducedFlashes: false,
        elapsedMs: 150,
      },
    );

    expect(shell.left.hold.querySelectorAll(".piece-preview-cell")).toHaveLength(4);
    const heldCell = shell.left.hold.querySelector<HTMLElement>(
      ".piece-preview-cell",
    );
    expect(heldCell?.dataset.shape).toBe("T");
    expect(heldCell?.dataset.pattern).toBe("crosses");
    expect(heldCell?.style.getPropertyValue("--piece-color")).toBe("#b65cff");
    expect(
      shell.left.hold.querySelector('[data-special-icon="glitch-core"] path')
        ?.getAttribute("d"),
    ).toBe(SPECIAL_ICON_PATHS["glitch-core"]);

    const slots = shell.left.preview.querySelectorAll<HTMLElement>(
      ".piece-preview-slot",
    );
    expect(slots).toHaveLength(5);
    expect(slots[0]?.classList.contains("is-primary")).toBe(true);
    expect(slots[0]?.dataset.displayShape).toBe("J");
    expect(slots[0]?.dataset.glitch).toBe("cycling");
    expect(slots[1]?.querySelectorAll(".piece-preview-cell")).toHaveLength(8);
    expect(slots[2]?.dataset.source).toBe("oversize");
    expect(slots[2]?.querySelectorAll(".piece-preview-cell")).toHaveLength(7);
    expect(shell.left.preview.querySelector(".piece-preview-badge")).toBeNull();
  });

  it("keeps a Glitch preview concealed without cycling for accessibility modes", () => {
    const shell = createAppShell(document, document.createElement("div"));
    const glitch = {
      source: "glitch",
      shape: "Z",
      previewCosmetics: {
        kind: "glitch-cycle",
        shapes: ["I", "J", "L", "O", "S", "T", "Z"],
        intervalMs: 150,
        finalShapeConcealed: true,
      },
    } as const;

    shell.left.setPiecePreviews(null, [glitch], {
      colorPalette: "standard",
      reducedMotion: true,
      reducedFlashes: false,
      elapsedMs: 150,
    });

    const primary = shell.left.preview.querySelector<HTMLElement>(
      ".piece-preview-slot.is-primary",
    );
    expect(primary?.dataset.glitch).toBe("static");
    expect(primary?.dataset.displayShape).toBe("concealed");
    expect(primary?.getAttribute("aria-label")).toBe(
      "Glitch Piece, shape concealed",
    );
  });

  it("shows independent music and effects controls", () => {
    const mount = document.createElement("div");
    const shell = createAppShell(document, mount);
    shell.setPreferences({
      ...DEFAULT_PREFERENCES,
      effectsEnabled: false,
      effectsVolume: 0.2,
      musicEnabled: true,
      musicVolume: 0.65,
    });

    expect(shell.settingsInputs.effectsEnabled.checked).toBe(false);
    expect(shell.settingsInputs.effectsVolume.value).toBe("0.2");
    expect(shell.settingsInputs.musicEnabled.checked).toBe(true);
    expect(shell.settingsInputs.musicVolume.value).toBe("0.65");
    expect(shell.settings.textContent).toContain("Music volume");
    expect(shell.settings.textContent).toContain("Effects volume");
  });

  it("exposes bounded connection-diagnostic actions with polite feedback", () => {
    const shell = createAppShell(document, document.createElement("div"));

    expect(shell.diagnosticsCopyButton.textContent).toBe("Copy diagnostics");
    expect(shell.diagnosticsClearButton.textContent).toBe("Clear diagnostics");
    expect(shell.diagnosticsStatus.getAttribute("aria-live")).toBe("polite");
  });

  it("keeps retained meter overflow inside the progressbar accessibility range", () => {
    const shell = createAppShell(document, document.createElement("div"));

    setPowerMeterAccessibility(shell.left.meter, 8);

    expect(shell.left.meter.getAttribute("aria-valuenow")).toBe("7");
    expect(shell.left.meter.getAttribute("aria-valuemax")).toBe("7");
    expect(shell.left.meter.getAttribute("aria-valuetext")).toBe(
      "Power ready; 1 charge retained",
    );
  });

  it("does not toggle an unchanged overlay or blackout visibility state", () => {
    const shell = createAppShell(document, document.createElement("div"));
    setElementHidden(shell.overlay, true);
    const hiddenSetter = vi.spyOn(shell.overlay, "hidden", "set");

    setElementHidden(shell.overlay, true);
    expect(hiddenSetter).not.toHaveBeenCalled();

    setElementHidden(shell.overlay, false);
    expect(hiddenSetter).toHaveBeenCalledOnce();
    expect(shell.overlay.hidden).toBe(false);
  });

  it("does not rewrite an unchanged overlay message", () => {
    const shell = createAppShell(document, document.createElement("div"));
    shell.setOverlayMessage("Match starts in 3");
    const readinessHidden = vi.spyOn(shell.readinessPanel, "hidden", "set");
    const messageHidden = vi.spyOn(shell.overlayText, "hidden", "set");
    const messageText = vi.spyOn(shell.overlayText, "textContent", "set");

    shell.setOverlayMessage("Match starts in 3");

    expect(readinessHidden).not.toHaveBeenCalled();
    expect(messageHidden).not.toHaveBeenCalled();
    expect(messageText).not.toHaveBeenCalled();
  });

  it("marks recovery messages as compact nonmodal status UI", () => {
    const shell = createAppShell(document, document.createElement("div"));

    shell.setOverlayMessage("Reconnecting…", "status");

    expect(shell.overlay.dataset.presentation).toBe("status");
    expect(shell.overlayText.textContent).toBe("Reconnecting…");
    expect(shell.overlayText.getAttribute("role")).toBe("status");
    expect(shell.overlayText.getAttribute("aria-live")).toBe("polite");
  });

  it("shows all marked powers as the same in-context cells used during play", () => {
    const shell = createAppShell(document, document.createElement("div"));
    showHelp(shell, "how");

    for (const special of [
      "column-bomb",
      "garbage-core",
      "glitch-core",
      "blackout",
      "barrier",
    ] as const) {
      const sample = shell.helpBody.querySelector<HTMLElement>(
        `.marked-cell-sample[data-special="${special}"]`,
      );
      expect(sample).not.toBeNull();
      expect(sample?.querySelector("path")?.getAttribute("d")).toBe(
        SPECIAL_ICON_PATHS[special],
      );
    }
    expect(shell.helpBody.textContent).toContain("Clears its entire column");
    expect(shell.helpBody.textContent).toContain("Sends extra garbage");
    expect(shell.helpBody.textContent).toContain(
      "Its preview rapidly cycles through every tetromino, hiding its real shape until it spawns.",
    );
    expect(shell.helpBody.textContent).toContain(
      "Once revealed, it plays like a normal piece but cannot be held.",
    );
  });

  it("groups the glossary by meter powers, marked powers, and special pieces", () => {
    const shell = createAppShell(document, document.createElement("div"));
    showHelp(shell, "powers");

    const meter = shell.helpBody.querySelector<HTMLElement>(
      '[data-glossary-group="meter"]',
    );
    const marked = shell.helpBody.querySelector<HTMLElement>(
      '[data-glossary-group="marked"]',
    );
    const pieces = shell.helpBody.querySelector<HTMLElement>(
      '[data-glossary-group="pieces"]',
    );

    expect(meter?.querySelector("h3")?.textContent).toBe("Meter powers");
    expect(meter?.textContent).toContain("Oversize");
    expect(meter?.textContent).toContain("Ghost Jam");
    expect(meter?.textContent).not.toContain("Blackout");
    expect(meter?.textContent).not.toContain("Barrier");
    expect(marked?.querySelector("h3")?.textContent).toBe("Marked-piece powers");
    expect(marked?.textContent).toContain("Blackout");
    expect(marked?.textContent).toContain("Barrier");
    expect(pieces?.querySelector("h3")?.textContent).toBe("Special pieces");
    expect(pieces?.textContent).toContain("Hollow Cross");
    expect(pieces?.textContent).toContain("Glitch Piece");
    expect(pieces?.textContent).toContain("Oversize shapes");
  });

  it("separates touch help from a complete action-to-key table", () => {
    const shell = createAppShell(document, document.createElement("div"));
    showHelp(shell, "controls");

    const touch = shell.helpBody.querySelector<HTMLElement>(
      '[data-control-scheme="touch"]',
    );
    const keyboard = shell.helpBody.querySelector<HTMLElement>(
      '[data-control-scheme="keyboard"]',
    );
    expect(touch?.querySelectorAll("li")).toHaveLength(3);
    expect(keyboard?.querySelector("table")).not.toBeNull();

    const rows = new Map(
      [...(keyboard?.querySelectorAll("tbody tr") ?? [])].map((row) => [
        row.querySelector("th")?.textContent,
        [...row.querySelectorAll("kbd")].map((key) => key.textContent),
      ]),
    );
    expect(rows.get("Move left/right")).toEqual(["←", "→", "A", "D"]);
    expect(rows.get("Soft drop")).toEqual(["↓", "S"]);
    expect(rows.get("Hard drop")).toEqual(["Space"]);
    expect(rows.get("Rotate clockwise")).toEqual(["↑", "X", "E"]);
    expect(rows.get("Rotate counterclockwise")).toEqual(["Z", "Q"]);
    expect(rows.get("Hold")).toEqual(["C", "Shift"]);
    expect(rows.get("Pause Practice")).toEqual(["P", "Esc"]);
  });

  it("swaps directional and rotation glyphs while Scramble is active", () => {
    const shell = createAppShell(document, document.createElement("div"));
    const glyph = (action: string): string | null =>
      shell.touchButtons.querySelector(`[data-action="${action}"]`)?.textContent ?? null;

    shell.setScrambled(true);
    expect(shell.arena.dataset.scrambled).toBe("true");
    expect(glyph("move-left")).toBe("→");
    expect(glyph("move-right")).toBe("←");
    expect(glyph("rotate-ccw")).toBe("↻");
    expect(glyph("rotate-cw")).toBe("↺");

    shell.setScrambled(false);
    expect(glyph("move-left")).toBe("←");
    expect(glyph("rotate-cw")).toBe("↻");
  });
});
