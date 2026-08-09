import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  LEAN_ONLY_TOOL_NAMES,
  SOLO_TOOL_NAMES,
  TEAM_TOOL_NAMES,
  parseTeamRouting,
  suppressedTools,
  type TeamRouting,
  type ToolProfile,
} from "./policy.ts";

const PLAN_STATE_TYPE = "plan-mode-state";

export default function toolProfile(pi: ExtensionAPI): void {
  let profile: ToolProfile = "lean";
  let defaultRouting: TeamRouting = { activeWorkers: 0, mode: "unknown" };
  let currentRouting = defaultRouting;
  const removedByProfile = new Set<string>();

  pi.registerFlag("full-tools", {
    description: "Start with every installed tool active",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("tool-profile", {
    description: "Show or switch the session tool profile: lean|full",
    getArgumentCompletions: (prefix: string) =>
      ["lean", "full", "status"]
        .filter((item) => item.startsWith(prefix.trim().toLowerCase()))
        .map((item) => ({ label: item, value: item })),
    handler: async (args: string, ctx: ExtensionContext) => {
      const requested = args.trim().toLowerCase();
      if (requested === "lean" || requested === "full") {
        profile = requested;
        applyProfile(currentRouting, ctx);
      } else if (requested !== "" && requested !== "status") {
        ctx.ui.notify("Usage: /tool-profile lean|full|status", "warning");
        return;
      }
      notifyStatus(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    profile = pi.getFlag("full-tools") === true ? "full" : "lean";
    defaultRouting = readDefaultRouting(ctx);
    currentRouting = defaultRouting;
    applyProfile(currentRouting, ctx);
  });

  // Some packages register their tools from session_start. Reapply after every
  // startup handler has completed so those late tools are included.
  pi.on("resources_discover", async (_event, ctx) => {
    applyProfile(currentRouting, ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    currentRouting = resolveRouting(parseTeamRouting(event.systemPrompt));
    applyProfile(currentRouting, ctx);
  });

  // Fallback for extension load orders where the team prompt is appended by a
  // later before_agent_start handler.
  pi.on("agent_start", async (_event, ctx) => {
    currentRouting = resolveRouting(parseTeamRouting(ctx.getSystemPrompt()));
    applyProfile(currentRouting, ctx);
  });

  function resolveRouting(routing: TeamRouting): TeamRouting {
    return routing.mode === "unknown" ? defaultRouting : routing;
  }

  function applyProfile(routing: TeamRouting, ctx: ExtensionContext): void {
    const desiredSuppressed = suppressedTools(profile, routing);
    const active = new Set(pi.getActiveTools());

    for (const name of desiredSuppressed) {
      if (active.delete(name)) {
        removedByProfile.add(name);
      }
    }

    if (!isPlanRestricted(ctx)) {
      for (const name of [...removedByProfile]) {
        if (!desiredSuppressed.has(name)) {
          active.add(name);
          removedByProfile.delete(name);
        }
      }
    }

    const ordered = pi
      .getAllTools()
      .map((tool: { name: string }) => tool.name)
      .filter((name: string) => active.has(name));
    pi.setActiveTools(ordered);
  }

  function notifyStatus(ctx: ExtensionContext): void {
    const deferred =
      profile === "full" && isPlanRestricted(ctx)
        ? " (restoration deferred until plan restrictions end)"
        : "";
    const managed = new Set<string>([
      ...LEAN_ONLY_TOOL_NAMES,
      ...SOLO_TOOL_NAMES,
      ...TEAM_TOOL_NAMES,
    ]);
    const allTools = pi.getAllTools().map((tool: { name: string }) => tool.name);
    const available = allTools.filter((name: string) => managed.has(name));
    const active = new Set(pi.getActiveTools());
    ctx.ui.notify(
      [
        `Tool profile: ${profile}${deferred}`,
        `Active tools: ${active.size} of ${allTools.length}`,
        `Suppressed: ${[...removedByProfile].sort().join(", ") || "none"}`,
        `Managed available: ${available.sort().join(", ") || "none"}`,
        `Managed active: ${
          available
            .filter((name) => active.has(name))
            .sort()
            .join(", ") || "none"
        }`,
      ].join("\n"),
      "info",
    );
  }
}

function readDefaultRouting(ctx: ExtensionContext): TeamRouting {
  if (!ctx.isProjectTrusted()) {
    return { activeWorkers: 0, mode: "unknown" };
  }

  try {
    const path = join(ctx.cwd, CONFIG_DIR_NAME, "agent", "agents-team.json");
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      enabled?: boolean;
      routingMode?: string;
    };
    if (config.enabled === false || config.routingMode === "solo") {
      return { activeWorkers: 0, mode: "solo" };
    }
    return { activeWorkers: 0, mode: "team" };
  } catch {
    return { activeWorkers: 0, mode: "unknown" };
  }
}

function isPlanRestricted(ctx: ExtensionContext): boolean {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as {
      customType?: string;
      data?: { mode?: string };
      type?: string;
    };
    if (entry.type === "custom" && entry.customType === PLAN_STATE_TYPE) {
      return entry.data?.mode === "planning" || entry.data?.mode === "write-plan";
    }
  }
  return false;
}
