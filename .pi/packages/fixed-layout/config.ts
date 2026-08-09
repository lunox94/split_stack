import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface FixedLayoutShortcuts {
  jumpBottom: string;
  nextAssistant: string;
  nextUser: string;
  previousAssistant: string;
  previousUser: string;
  scrollDown: string;
  scrollUp: string;
}

export interface FixedLayoutConfig {
  autoCopyOnSelect: boolean;
  enabled: boolean;
  mouseScroll: boolean;
  outputPad: number;
  scrollAwayCard: boolean;
  shortcuts: FixedLayoutShortcuts;
}

const DEFAULT_SHORTCUTS: FixedLayoutShortcuts = {
  jumpBottom: "ctrl+alt+g",
  nextAssistant: "ctrl+alt+.",
  nextUser: "ctrl+shift+i",
  previousAssistant: "ctrl+alt+,",
  previousUser: "ctrl+shift+u",
  scrollDown: "super+down",
  scrollUp: "super+up",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function shortcutSetting(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : fallback;
}

export function parseFixedLayoutConfig(value: unknown): FixedLayoutConfig {
  const settings = isRecord(value) ? value : {};
  const powerline = isRecord(settings.powerline) ? settings.powerline : {};
  const fixedLayout = isRecord(settings.fixedLayout) ? settings.fixedLayout : {};
  const shortcuts = isRecord(settings.powerlineShortcuts) ? settings.powerlineShortcuts : {};
  const outputPad =
    typeof settings.outputPad === "number" && Number.isFinite(settings.outputPad)
      ? Math.max(0, Math.floor(settings.outputPad))
      : 0;

  return {
    autoCopyOnSelect: booleanSetting(
      fixedLayout.autoCopyOnSelect,
      booleanSetting(powerline.copyOnSelect, true),
    ),
    enabled: booleanSetting(fixedLayout.enabled, booleanSetting(powerline.fixedEditor, true)),
    mouseScroll: booleanSetting(
      fixedLayout.mouseScroll,
      booleanSetting(powerline.mouseScroll, true),
    ),
    outputPad,
    scrollAwayCard: booleanSetting(
      fixedLayout.scrollAwayCard,
      booleanSetting(powerline.scrollAwayCard, true),
    ),
    shortcuts: {
      jumpBottom: shortcutSetting(shortcuts.jumpChatBottom, DEFAULT_SHORTCUTS.jumpBottom),
      nextAssistant: shortcutSetting(shortcuts.jumpNextLlmMessage, DEFAULT_SHORTCUTS.nextAssistant),
      nextUser: shortcutSetting(shortcuts.jumpNextUserMessage, DEFAULT_SHORTCUTS.nextUser),
      previousAssistant: shortcutSetting(
        shortcuts.jumpPreviousLlmMessage,
        DEFAULT_SHORTCUTS.previousAssistant,
      ),
      previousUser: shortcutSetting(
        shortcuts.jumpPreviousUserMessage,
        DEFAULT_SHORTCUTS.previousUser,
      ),
      scrollDown: shortcutSetting(shortcuts.scrollChatDown, DEFAULT_SHORTCUTS.scrollDown),
      scrollUp: shortcutSetting(shortcuts.scrollChatUp, DEFAULT_SHORTCUTS.scrollUp),
    },
  };
}

export function readFixedLayoutConfig(cwd: string): FixedLayoutConfig {
  try {
    return parseFixedLayoutConfig(
      JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8")),
    );
  } catch {
    return parseFixedLayoutConfig({});
  }
}
