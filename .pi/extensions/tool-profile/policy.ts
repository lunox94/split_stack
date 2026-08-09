export const TEAM_TOOL_NAMES = [
  "delegate_task",
  "agent_status",
  "agent_result",
  "agent_message",
  "ping_agents",
  "wait_for_agents",
  "agent_cancel",
] as const;

export const LEAN_ONLY_TOOL_NAMES = [
  "ast_dump",
  "ctx_doctor",
  "ctx_upgrade",
  "ctx_purge",
  "ctx_insight",
  "ctx_stats",
] as const;

export const SOLO_TOOL_NAMES = ["subagent"] as const;

export type ToolProfile = "lean" | "full";
export type TeamRouting = {
  activeWorkers: number;
  mode: "solo" | "team" | "unknown";
};

export function parseTeamRouting(systemPrompt: string): TeamRouting {
  const workerMatch = systemPrompt.match(/Active worker count in this session snapshot:\s*(\d+)/);
  const activeWorkers = Number.parseInt(workerMatch?.[1] ?? "0", 10);

  if (systemPrompt.includes("## Routing mode: solo")) {
    return { activeWorkers, mode: "solo" };
  }
  if (
    systemPrompt.includes("# Pi Agents Team Orchestrator Contract") ||
    systemPrompt.includes("## Available worker profiles")
  ) {
    return { activeWorkers, mode: "team" };
  }
  return { activeWorkers, mode: "unknown" };
}

export function suppressedTools(profile: ToolProfile, routing: TeamRouting): Set<string> {
  const suppressed = new Set<string>();
  if (routing.mode === "team") {
    for (const name of SOLO_TOOL_NAMES) suppressed.add(name);
  }
  if (routing.mode === "solo") {
    suppressed.add("delegate_task");
    if (routing.activeWorkers === 0) {
      for (const name of TEAM_TOOL_NAMES) suppressed.add(name);
    }
  }
  if (profile === "full") return suppressed;

  for (const name of LEAN_ONLY_TOOL_NAMES) suppressed.add(name);
  return suppressed;
}
