/** Human-readable context usage for the Split Stack powerline. */

import type {
  ExtensionAPI,
  ExtensionContext,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";

export const CONTEXT_STATUS_KEY = "split-stack-context";

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatContextUsage(
  tokens: number | null,
  contextWindow: number,
  percent: number | null,
): string {
  const used = tokens === null ? "estimating" : formatTokens(tokens);
  const ratio = percent === null ? "—" : `${percent.toFixed(1)}%`;
  return `Context ${used}/${formatTokens(contextWindow)} (${ratio})`;
}

function contextColor(percent: number | null): ThemeColor {
  if (percent !== null && percent > 90) return "error";
  if (percent !== null && percent > 70) return "warning";
  return "dim";
}

function updateStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  const usage = ctx.getContextUsage();
  if (!usage) {
    ctx.ui.setStatus(CONTEXT_STATUS_KEY, undefined);
    return;
  }

  const text = formatContextUsage(usage.tokens, usage.contextWindow, usage.percent);
  ctx.ui.setStatus(
    CONTEXT_STATUS_KEY,
    ctx.ui.theme.fg(contextColor(usage.percent), text),
  );
}

export default function contextStatus(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => updateStatus(ctx));
  pi.on("agent_start", (_event, ctx) => updateStatus(ctx));
  pi.on("message_end", (_event, ctx) => updateStatus(ctx));
  pi.on("agent_end", (_event, ctx) => updateStatus(ctx));
  pi.on("session_compact", (_event, ctx) => updateStatus(ctx));
  pi.on("model_select", (_event, ctx) => updateStatus(ctx));
}
