// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { DEFAULT_PREFERENCES } from "../../src/persistence/settings";
import { SPECIAL_ICON_PATHS } from "../../src/render/special-icons";
import {
  createAppShell,
  setPowerMeterAccessibility,
  showHelp,
} from "../../src/ui/shell";

describe("application shell", () => {
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

  it("shows the exact three marked-cell icons and trigger explanations in How to Play", () => {
    const shell = createAppShell(document, document.createElement("div"));
    showHelp(shell, "how");

    for (const special of [
      "column-bomb",
      "garbage-core",
      "glitch-core",
    ] as const) {
      const icon = shell.helpBody.querySelector<SVGElement>(
        `[data-special-icon="${special}"]`,
      );
      expect(icon).not.toBeNull();
      expect(icon?.querySelector("path")?.getAttribute("d")).toBe(
        SPECIAL_ICON_PATHS[special],
      );
    }
    expect(shell.helpBody.textContent).toContain("Clears its entire column");
    expect(shell.helpBody.textContent).toContain("Sends extra garbage");
    expect(shell.helpBody.textContent).toContain("Sends a Glitch piece");
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
