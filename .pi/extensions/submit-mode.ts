import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SubmitMode = "multiline" | "submit";

const MODES: SubmitMode[] = ["multiline", "submit"];
const SUBCOMMANDS = [...MODES, "status"];

function describeMode(mode: SubmitMode): string {
  return mode === "multiline"
    ? "Submit mode: Enter inserts a newline; Command+Enter submits."
    : "Submit mode: Enter submits; Shift+Enter inserts a newline.";
}

export default function submitMode(pi: ExtensionAPI): void {
  let mode: SubmitMode = "multiline";
  let applyMode: (() => void) | undefined;
  let cleanup: (() => void) | undefined;
  let restoreBindings: (() => void) | undefined;

  pi.registerCommand("submit-mode", {
    description: "Toggle or report the Enter submit mode",
    getArgumentCompletions: (prefix: string) =>
      SUBCOMMANDS.flatMap((candidate) =>
        candidate.startsWith(prefix.trim().toLowerCase())
          ? [{ label: candidate, value: candidate }]
          : [],
      ),
    handler: (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (requested === "status") {
        ctx.ui.notify(describeMode(mode), "info");
        return Promise.resolve();
      }
      if (requested && !MODES.includes(requested as SubmitMode)) {
        ctx.ui.notify("Usage: /submit-mode [multiline|submit|status]", "warning");
        return Promise.resolve();
      }

      if (requested) {
        mode = requested as SubmitMode;
      } else {
        mode = mode === "multiline" ? "submit" : "multiline";
      }
      applyMode?.();
      ctx.ui.notify(describeMode(mode), "info");
      return Promise.resolve();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const previousEditor = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const originalBindings = keybindings.getUserBindings();
      restoreBindings = () => keybindings.setUserBindings(originalBindings);
      applyMode = () => {
        keybindings.setUserBindings(
          mode === "multiline"
            ? {
                ...originalBindings,
                "tui.input.newLine": ["enter", "shift+enter", "ctrl+j"],
                "tui.input.submit": "super+enter",
              }
            : originalBindings,
        );
      };
      applyMode();

      return previousEditor?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
    });

    cleanup = () => {
      restoreBindings?.();
      ctx.ui.setEditorComponent(previousEditor);
    };
  });

  pi.on("session_shutdown", () => cleanup?.());
}
