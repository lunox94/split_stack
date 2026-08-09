import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Plan mode states — duplicated here to avoid circular imports with state.ts. */
export type PlanMode = "idle" | "planning" | "write-plan" | "executing";

/** Planning: read-only exploration + structured interaction. */
export const PLANNING_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls", // read-only exploration
  "todo", // rpiv-todo: create tasks for later
  "ask_user_question", // rpiv-ask-user-question: structured decisions
  "web_search",
  "fetch_content", // pi-web-access: research
  "lsp_diagnostics",
  "lsp_navigation", // pi-lens: code navigation
];

/** Write-plan: planning tools + write and edit (path-restricted by tool_call handler). */
export const WRITE_PLAN_TOOLS = [
  ...PLANNING_TOOLS,
  "write", // path-restricted in tool_call handler
  "edit", // path-restricted in tool_call handler
];

// Executing and idle modes have no tool restriction — applyToolRestrictions
// restores the full tool set for those states.

export function applyToolRestrictions(pi: ExtensionAPI, mode: PlanMode): void {
  switch (mode) {
    case "planning":
      pi.setActiveTools(PLANNING_TOOLS);
      break;
    case "write-plan":
      pi.setActiveTools(WRITE_PLAN_TOOLS);
      break;
    case "executing":
    case "idle":
      pi.setActiveTools(pi.getAllTools().map((tool: { name: string }) => tool.name));
      break;
    default:
      break;
  }
}

// Plan-mode bash filter: this is the enforcement boundary for bash calls in
// planning/write-plan, including direct Pi sessions started by `bin/agent --review`.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link)/i,
  /\byarn\s+(add|remove|install)/i,
  /\bbundle\s+(install|update|add|remove)/i,
  /\bgem\s+(install|uninstall)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert)/i,
  /\bsudo\b/i,
  /\bkill\b/i,
  /\breboot\b/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
  /\brails\s+(db:|generate|destroy|runner)/i,
  /\brake\s+(db:)/i,
  /\bdocker\s+(rm|stop|kill|exec|run)/i,
  /(?:^|[\s"'=])(?:[^\s"'=]*\/)?\.env(?![^\s"'=]*\.example(?:[\s"'=]|$))[^\s"'=]*(?=[\s"'=]|$)/i,
  /(?:^|[\s"'=])(?:[^\s"'=]*\/)?config\/(?:master\.key|credentials\.yml\.enc|credentials(?:\/[^\s"'=]*)?)(?=[\s"'=]|$)/i,
  /\brails\s+credentials:show\b/i,
  /\btask\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
];

// Strictly local, read-only commands. Network research should use web_search
// and fetch_content tools instead of shell commands.
const SAFE_PATTERNS: RegExp[] = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*type\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|outdated|audit)/i,
  /^\s*bundle\s+(list|show|info|outdated)/i,
  /^\s*rails\s+routes\b/i,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*jq\b/,
  /^\s*awk\b/,
  /^\s*bat\b/,
  /^\s*docker\s+(ps|logs|images|inspect)/i,
];

export function isSafeCommand(command: string): boolean {
  const isDestructive = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
  const isSafe = SAFE_PATTERNS.some((pattern) => pattern.test(command));
  return !isDestructive && isSafe;
}
