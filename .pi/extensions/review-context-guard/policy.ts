import { extname } from "node:path";

const MAX_UNBOUNDED_SOURCE_BYTES = 12 * 1024;
const SOURCE_EXTENSIONS = new Set([
  ".css",
  ".dart",
  ".erb",
  ".html",
  ".js",
  ".jsx",
  ".rake",
  ".rb",
  ".scss",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const HIGH_OUTPUT_COMMANDS = [
  /(^|\s)task\s+(?:test|lint(?::[^\s]+)?)(?:\s|$)/i,
  /(^|\s)(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|lint)(?:\s|$)/i,
  /(^|\s)(?:bundle\s+exec\s+rspec|bin\/rails\s+test|flutter\s+test|dart\s+test)(?:\s|$)/i,
  /(^|\s)(?:task\s+git:|git\s+)(?:diff|log)(?:\s|$)/i,
  /(^|\s)gh\s+(?:api|pr\s+checks|run\s+(?:view|watch))(?:\s|$)/i,
];

export interface GuardInput {
  active_tools: string[];
  command?: string;
  file_bytes?: number;
  has_limit?: boolean;
  mcp_server?: string;
  path?: string;
  phase: string;
  tool_name: string;
}

interface GuardResult {
  block: true;
  reason: string;
}

export function evaluateReviewContextGuard(input: GuardInput): GuardResult | undefined {
  if (input.phase !== "review") return;

  if (input.tool_name === "mcp" && input.mcp_server) {
    return {
      block: true,
      reason:
        "Review context guard: full MCP server schema listing blocked. Call or describe the exact tool when known; otherwise use MCP search for the specific capability.",
    };
  }

  if (
    input.tool_name === "ctx_execute_file" &&
    input.path &&
    SOURCE_EXTENSIONS.has(extname(input.path).toLowerCase())
  ) {
    return {
      block: true,
      reason:
        "Review context guard: source-file sandbox analysis blocked. Use Pi Lens module_report/read_symbol/read_enclosing so only relevant code enters context.",
    };
  }

  if (
    input.tool_name === "read" &&
    input.path &&
    SOURCE_EXTENSIONS.has(extname(input.path).toLowerCase()) &&
    !input.has_limit &&
    (input.file_bytes ?? 0) > MAX_UNBOUNDED_SOURCE_BYTES
  ) {
    return {
      block: true,
      reason:
        "Review context guard: large unbounded source read blocked. Use Pi Lens module_report/read_symbol/read_enclosing, or retry read with offset/limit.",
    };
  }

  const command = input.command ?? "";
  if (
    input.tool_name === "bash" &&
    command &&
    !command.includes("REVIEW_RAW_OUTPUT=1") &&
    input.active_tools.includes("mcp") &&
    HIGH_OUTPUT_COMMANDS.some((pattern) => pattern.test(command))
  ) {
    return {
      block: true,
      reason:
        "Review context guard: predicted high-output command blocked. Use the context-mode MCP ctx_execute tool and request findings plus exit status. Prefix REVIEW_RAW_OUTPUT=1 only when raw evidence is required.",
    };
  }
}

export function reviewMemorySearchLimit(phase: string, limit: unknown): unknown {
  return phase === "review" && limit === undefined ? 5 : limit;
}
