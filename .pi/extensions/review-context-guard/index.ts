import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { evaluateReviewContextGuard, reviewMemorySearchLimit } from "./policy.ts";

const PHASE_ENTRY = "workflow-metrics-phase";

export default function reviewContextGuard(pi: ExtensionAPI) {
  pi.registerCommand("review-phase", {
    description: "Enable, disable, or report review-only context guards",
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (requested === "on") {
        pi.appendEntry(PHASE_ENTRY, { phase: "review" });
        ctx.ui.notify("Review context guard enabled for this session branch.", "info");
      } else if (requested === "off") {
        pi.appendEntry(PHASE_ENTRY, { phase: "unclassified" });
        ctx.ui.notify("Review context guard disabled.", "info");
      } else {
        ctx.ui.notify(`Review context phase: ${currentPhase(ctx)}. Use /review-phase on|off.`, "info");
      }
    },
  });

  pi.on("tool_call", (event, ctx) => {
    const phase = currentPhase(ctx);
    if (phase !== "review") return;

    if (event.toolName === "mcp") {
      const input = event.input as Record<string, unknown>;
      if (typeof input.server !== "string") return;
      return evaluateReviewContextGuard({
        active_tools: pi.getActiveTools(),
        mcp_server: input.server,
        phase,
        tool_name: "mcp",
      });
    }

    if (event.toolName === "memory_search") {
      const input = event.input as Record<string, unknown>;
      input.limit = reviewMemorySearchLimit(phase, input.limit);
      return;
    }

    if (event.toolName === "ctx_execute_file") {
      const input = event.input as Record<string, unknown>;
      if (typeof input.path !== "string") return;
      return evaluateReviewContextGuard({
        active_tools: pi.getActiveTools(),
        path: input.path,
        phase,
        tool_name: "ctx_execute_file",
      });
    }

    if (isToolCallEventType("read", event)) {
      const path = localSourcePath(ctx.cwd, event.input.path);
      if (!path) return;
      return evaluateReviewContextGuard({
        active_tools: pi.getActiveTools(),
        file_bytes: statSync(path).size,
        has_limit: event.input.limit !== undefined,
        path,
        phase: "review",
        tool_name: "read",
      });
    }

    if (isToolCallEventType("bash", event)) {
      return evaluateReviewContextGuard({
        active_tools: pi.getActiveTools(),
        command: event.input.command,
        phase: "review",
        tool_name: "bash",
      });
    }
  });
}

function localSourcePath(cwd: string, rawPath: string): string | undefined {
  const path = resolve(cwd, rawPath.replace(/^@/, ""));
  const local = relative(cwd, path);
  if (local.startsWith("..") || isAbsolute(local)) return;

  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return;
  }
}

function currentPhase(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!entry || entry.type !== "custom" || entry.customType !== PHASE_ENTRY) continue;
    const phase =
      entry.data && typeof entry.data === "object"
        ? (entry.data as Record<string, unknown>).phase
        : undefined;
    return typeof phase === "string" ? phase : "unclassified";
  }
  return "unclassified";
}
