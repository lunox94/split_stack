import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, visibleWidth } from "@earendil-works/pi-tui";

import { renderFixedEditorCluster } from "./cluster.ts";
import { DEFAULT_SCROLL_REPAINT_THROTTLE_MS, TerminalSplitCompositor } from "./compositor.ts";
import { type FixedLayoutConfig, readFixedLayoutConfig } from "./config.ts";
import {
  type ChatDirection,
  type ChatRole,
  collectChatMessageStartLines,
  findFixedContainers,
} from "./layout.ts";
import { matchesConfiguredShortcut } from "./shortcuts.ts";

type EditorLike = {
  handleInput(data: string): void;
};

type KeybindingsLike = {
  matches(data: string, action: string): boolean;
};

type UiContext = {
  hasUI: boolean;
  mode: string;
  ui: {
    getEditorComponent():
      | ((tui: unknown, theme: unknown, keybindings: KeybindingsLike) => EditorLike)
      | undefined;
    notify(message: string, level: "error" | "info" | "warning"): void;
    setEditorComponent(
      factory: (tui: unknown, theme: unknown, keybindings: KeybindingsLike) => EditorLike,
    ): void;
  };
};

function isEditor(value: unknown): value is EditorLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "handleInput") === "function"
  );
}

export default function fixedLayout(pi: ExtensionAPI): void {
  let compositor: TerminalSplitCompositor | null = null;
  let tuiRef: unknown = null;

  const teardown = (): void => {
    compositor?.dispose({ resetExtendedKeyboardModes: true });
    compositor = null;
    tuiRef = null;
  };

  const jumpToBottom = (): boolean => compositor?.jumpToRootBottom() ?? false;

  const jumpToMessage = (ctx: UiContext, role: ChatRole, direction: ChatDirection): boolean => {
    if (!compositor || !tuiRef) return false;

    const targets = collectChatMessageStartLines(tuiRef, role);
    const label = role === "assistant" ? "assistant" : "user";
    if (targets.length === 0) {
      ctx.ui.notify(`No ${label} messages found`, "info");
      return false;
    }

    const jumped =
      direction === "previous"
        ? compositor.jumpToPreviousRootTarget(targets)
        : compositor.jumpToNextRootTarget(targets);
    if (!jumped) ctx.ui.notify(`No ${direction} ${label} message`, "info");

    return jumped;
  };

  const handleNavigationInput = (
    data: string,
    config: FixedLayoutConfig,
    ctx: UiContext,
  ): boolean => {
    if (isKeyRelease(data)) return false;
    if (matchesConfiguredShortcut(data, config.shortcuts.jumpBottom)) {
      jumpToBottom();
      return true;
    }
    if (matchesConfiguredShortcut(data, config.shortcuts.previousUser)) {
      jumpToMessage(ctx, "user", "previous");
      return true;
    }
    if (matchesConfiguredShortcut(data, config.shortcuts.nextUser)) {
      jumpToMessage(ctx, "user", "next");
      return true;
    }
    if (matchesConfiguredShortcut(data, config.shortcuts.previousAssistant)) {
      jumpToMessage(ctx, "assistant", "previous");
      return true;
    }
    if (matchesConfiguredShortcut(data, config.shortcuts.nextAssistant)) {
      jumpToMessage(ctx, "assistant", "next");
      return true;
    }

    return false;
  };

  const wrapEditorInput = (
    editor: EditorLike,
    keybindings: KeybindingsLike,
    config: FixedLayoutConfig,
    ctx: UiContext,
  ): void => {
    const originalHandleInput = editor.handleInput.bind(editor);
    editor.handleInput = (data: string) => {
      if (handleNavigationInput(data, config, ctx)) return;

      const isSubmit =
        keybindings.matches(data, "tui.input.submit") &&
        !keybindings.matches(data, "tui.input.newLine");
      if (isSubmit || keybindings.matches(data, "app.message.followUp")) jumpToBottom();

      originalHandleInput(data);
    };
  };

  const install = (
    ctx: UiContext,
    tui: unknown,
    editor: EditorLike,
    config: FixedLayoutConfig,
  ): boolean => {
    const containers = findFixedContainers(tui, editor);
    if (!containers || typeof tui !== "object" || tui === null) {
      ctx.ui.notify("Fixed layout unavailable: Pi's TUI container layout changed", "warning");
      return false;
    }

    const terminal = Reflect.get(tui, "terminal");
    if (
      typeof terminal !== "object" ||
      terminal === null ||
      typeof Reflect.get(terminal, "write") !== "function"
    ) {
      ctx.ui.notify("Fixed layout unavailable: Pi's terminal API changed", "warning");
      return false;
    }

    let candidate: TerminalSplitCompositor | null = null;
    try {
      candidate = new TerminalSplitCompositor({
        autoCopyOnSelect: config.autoCopyOnSelect,
        getShowHardwareCursor: () => {
          const getter = Reflect.get(tui, "getShowHardwareCursor");
          return typeof getter === "function" && getter.call(tui) === true;
        },
        keyboardScrollShortcuts: {
          down: config.shortcuts.scrollDown,
          up: config.shortcuts.scrollUp,
        },
        mouseScroll: config.mouseScroll,
        onCopySelection: (text, source) => {
          copyToClipboard(text);
          if (source === "explicit") ctx.ui.notify("Copied selection", "info");
        },
        outputPad: config.outputPad,
        renderCluster: (width, terminalRows) => {
          const statusLines = containers.status
            ? (candidate
                ?.renderHidden(containers.status, width)
                .filter((line) => visibleWidth(line) > 0) ?? [])
            : [];
          const aboveLines = candidate?.renderHidden(containers.above, width) ?? [];
          const editorLines = candidate?.renderHidden(containers.editor, width) ?? [];
          const belowLines = candidate?.renderHidden(containers.below, width) ?? [];
          const footerLines = containers.footer
            ? (candidate?.renderHidden(containers.footer, width) ?? [])
            : [];

          return renderFixedEditorCluster({
            editorLines,
            placement: "above",
            primaryLines: [],
            secondaryLines: [...belowLines, ...footerLines],
            statusLines: [...statusLines, ...aboveLines],
            terminalRows,
            width,
          });
        },
        scrollAwayNavigationCard: config.scrollAwayCard
          ? {
              onClickBottom: jumpToBottom,
              shortcuts: [
                { id: "bottom", shortcutLabel: config.shortcuts.jumpBottom },
                { id: "previousUser", shortcutLabel: config.shortcuts.previousUser },
                { id: "nextUser", shortcutLabel: config.shortcuts.nextUser },
                { id: "previousAssistant", shortcutLabel: config.shortcuts.previousAssistant },
                { id: "nextAssistant", shortcutLabel: config.shortcuts.nextAssistant },
              ],
            }
          : undefined,
        scrollRepaintThrottleMs: DEFAULT_SCROLL_REPAINT_THROTTLE_MS,
        terminal: terminal as { columns: number; rows: number; write(data: string): void },
        tui,
      });

      if (containers.status) candidate.hideRenderable(containers.status);
      candidate.hideRenderable(containers.above);
      candidate.hideRenderable(containers.editor);
      candidate.hideRenderable(containers.below);
      if (containers.footer) candidate.hideRenderable(containers.footer);
      candidate.install();
      compositor = candidate;
      tuiRef = tui;

      const requestRender = Reflect.get(tui, "requestRender");
      if (typeof requestRender === "function") requestRender.call(tui, true);
      return true;
    } catch (error) {
      candidate?.dispose({ resetExtendedKeyboardModes: true });
      ctx.ui.notify(
        `Fixed layout failed safely: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return false;
    }
  };

  pi.registerCommand("fixed-layout", {
    description: "Report whether the fixed editor and footer layout is active",
    handler: (_args, ctx) => {
      ctx.ui.notify(compositor ? "Fixed layout active" : "Fixed layout inactive", "info");
      return Promise.resolve();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    teardown();
    if (ctx.mode !== "tui") return;

    const config = readFixedLayoutConfig(ctx.cwd);
    if (!config.enabled) return;

    const uiContext = ctx as unknown as UiContext;
    const previousEditor = uiContext.ui.getEditorComponent();
    if (!previousEditor) {
      uiContext.ui.notify("Fixed layout unavailable: no editor factory to wrap", "warning");
      return;
    }

    let activeEditor: EditorLike | null = null;
    let activeKeybindings: KeybindingsLike | null = null;
    let activeTui: unknown = null;
    try {
      uiContext.ui.setEditorComponent((tui, theme, keybindings) => {
        const editor = previousEditor(tui, theme, keybindings);
        if (!isEditor(editor)) {
          throw new Error("Previous editor factory returned an invalid editor");
        }

        activeEditor = editor;
        activeKeybindings = keybindings;
        activeTui = tui;
        return editor;
      });
    } catch (error) {
      uiContext.ui.notify(
        `Fixed layout failed safely: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return;
    }

    if (!activeEditor || !activeKeybindings || !activeTui) {
      uiContext.ui.notify(
        "Fixed layout unavailable: editor installation did not complete",
        "warning",
      );
      return;
    }

    if (install(uiContext, activeTui, activeEditor, config)) {
      wrapEditorInput(activeEditor, activeKeybindings, config, uiContext);
    }
  });

  pi.on("session_shutdown", () => teardown());
}
