/**
 * Thinking Display Extension
 *
 * Keeps expanded thinking blocks readable in the Pi TUI by stripping standalone
 * empty HTML comments that some models emit as internal separators. This is a
 * project-local workaround so it survives `pi update` without patching
 * node_modules.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HIDDEN_THINKING_LABEL = "Thinking details hidden";
const EMPTY_HTML_COMMENT_LINE = /^[\t ]*<!--[\t ]*-->[\t ]*(?:\r?\n)?/gm;

type MessageWithContent = {
  content?: unknown;
};

type ThinkingContent = {
  type: "thinking";
  thinking: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isThinkingContent(value: unknown): value is ThinkingContent {
  return isRecord(value) && value.type === "thinking" && typeof value.thinking === "string";
}

function stripEmptyHtmlCommentLines(text: string): string {
  return text.replace(EMPTY_HTML_COMMENT_LINE, "");
}

function sanitizeThinkingBlocks(message: unknown): boolean {
  if (!isRecord(message)) return false;

  const candidate = message as MessageWithContent;
  if (!Array.isArray(candidate.content)) return false;

  let changed = false;
  for (const block of candidate.content) {
    if (!isThinkingContent(block)) continue;

    const sanitized = stripEmptyHtmlCommentLines(block.thinking);
    if (sanitized === block.thinking) continue;

    block.thinking = sanitized;
    changed = true;
  }

  return changed;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setHiddenThinkingLabel(HIDDEN_THINKING_LABEL);
  });

  // Mutate streaming messages before the TUI renders them. Return values are
  // ignored for message_update, but the event message is the live message object.
  pi.on("message_update", async (event) => {
    sanitizeThinkingBlocks(event.message);
  });

  // Also sanitize finalized messages so resumed/exported sessions do not keep
  // rendering standalone empty comments.
  pi.on("message_end", async (event) => {
    if (!sanitizeThinkingBlocks(event.message)) return;

    return { message: event.message };
  });

  pi.registerCommand("thinking-display", {
    description: "Show thinking display controls",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Thinking details: Ctrl+T toggles expanded/collapsed blocks; standalone empty HTML comments are stripped.",
        "info",
      );
    },
  });
}
