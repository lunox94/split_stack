import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { relativePlanPath, resolvePlanWriteTarget } from "./plan-file.ts";
import { getExecutingPrompt, getPlanningPrompt, getWritePlanPrompt } from "./prompts.ts";
import {
  INITIAL_STATE,
  type PlanModeState,
  persistState,
  restoreState,
  transitionTo,
  updateStatus,
} from "./state.ts";
import { applyToolRestrictions, isSafeCommand, PLANNING_TOOLS, WRITE_PLAN_TOOLS } from "./tools.ts";

const PLAN_COMMAND_COMPLETIONS = ["off", "write", "execute", "refine", "status"];
const STATUS_KEY = "plan-mode";

export default function planModeExtension(pi: ExtensionAPI): void {
  const state: PlanModeState = { ...INITIAL_STATE };

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("plan", {
    description: `Plan mode: explore safely (${PLANNING_TOOLS.length} planning tools, ${WRITE_PLAN_TOOLS.length} write-plan tools), write PLAN.md, then execute`,
    getArgumentCompletions: (prefix: string) => {
      const normalizedPrefix = prefix.trim().toLowerCase();
      return PLAN_COMMAND_COMPLETIONS.filter((c) => c.startsWith(normalizedPrefix)).map((c) => ({
        value: c,
        label: c,
      }));
    },
    handler: async (args: unknown, ctx: ExtensionContext) => {
      const parts = normalizeArgs(args);
      const subcommand = parts[0]?.toLowerCase();

      switch (subcommand) {
        case "off":
          transitionTo("idle", state, pi, ctx);
          ctx.ui.notify("Plan mode disabled. Full access restored.", "info");
          return;
        case "status":
          notifyStatus(ctx);
          return;
        case "write":
          if (state.mode !== "planning") {
            ctx.ui.notify("/plan write is only available from planning mode.", "warning");
            notifyStatus(ctx);
            return;
          }
          transitionTo("write-plan", state, pi, ctx);
          ctx.ui.notify(
            `Write-plan mode enabled. Write ${state.planPath ?? "plans/.../PLAN.md"}.`,
            "info",
          );
          pi.sendUserMessage("Write the plan document now.", {
            deliverAs: "followUp",
          });
          return;
        case "execute":
          if (state.mode !== "write-plan") {
            ctx.ui.notify("/plan execute is only available from write-plan mode.", "warning");
            notifyStatus(ctx);
            return;
          }
          transitionTo("executing", state, pi, ctx);
          ctx.ui.notify("Executing plan. Full access restored.", "info");
          pi.sendUserMessage("Begin executing the plan.", {
            deliverAs: "followUp",
          });
          return;
        case "refine":
          if (state.mode !== "write-plan") {
            ctx.ui.notify("/plan refine is only available from write-plan mode.", "warning");
            notifyStatus(ctx);
            return;
          }
          transitionTo("planning", state, pi, ctx);
          ctx.ui.notify("Returned to planning mode for refinement.", "info");
          return;
        default:
          break; // fall through to default enter-planning logic
      }

      if (state.mode !== "idle") {
        notifyStatus(ctx);
        return;
      }

      const inlineTicket = parts.find((part) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(part));
      let ticketId = inlineTicket;
      if (!ticketId) {
        const input = await ctx.ui.input("Plan or tracker ID:", "PLAN-001");
        ticketId = normalizePlanId(input);
      }

      if (!ticketId) {
        ctx.ui.notify("Plan mode cancelled — no ticket ID.", "warning");
        return;
      }

      state.ticketId = ticketId;
      state.planPath = relativePlanPath(state.ticketId);
      state.planWritten = false;
      state.explorationNotes = [];
      transitionTo("planning", state, pi, ctx);
      ctx.ui.notify(`Plan mode enabled for ${state.ticketId}.`, "info");
    },
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle plan mode",
    handler: async (ctx: ExtensionContext) => {
      if (state.mode === "idle") {
        const input = await ctx.ui.input("Plan or tracker ID:", "PLAN-001");
        const ticketId = normalizePlanId(input);
        if (!ticketId) {
          ctx.ui.notify("Plan mode cancelled — no ticket ID.", "warning");
          return;
        }
        state.ticketId = ticketId;
        state.planPath = relativePlanPath(state.ticketId);
        state.planWritten = false;
        transitionTo("planning", state, pi, ctx);
        ctx.ui.notify(`Plan mode enabled for ${state.ticketId}.`, "info");
      } else {
        transitionTo("idle", state, pi, ctx);
        ctx.ui.notify("Plan mode disabled. Full access restored.", "info");
      }
    },
  });

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    const startInPlanMode = pi.getFlag("plan") === true;
    const restored = restoreState(ctx);
    if (restored) {
      Object.assign(state, restored);
    }
    if (startInPlanMode && state.mode === "idle") {
      state.mode = "planning";
      state.planPath ??= relativePlanPath(state.ticketId);
      persistState(pi, state);
    }

    if (state.mode !== "idle") {
      applyToolRestrictions(pi, state.mode);
      updateStatus(state, ctx);
    }

    const allToolNames = pi.getAllTools().map((tool: { name: string }) => tool.name);
    for (const expected of ["todo", "ask_user_question"]) {
      if (!allToolNames.includes(expected)) {
        ctx.ui.notify(
          `plan-mode: '${expected}' tool not found. Some features will be limited.`,
          "warning",
        );
      }
    }
  });

  pi.on("before_agent_start", async () => {
    if (state.mode === "idle") {
      return;
    }

    const promptContent = promptForCurrentMode(state);
    return {
      message: {
        customType: "plan-mode-context",
        content: promptContent,
        display: false,
      },
    };
  });

  pi.on("context", async (event) => {
    if (state.mode !== "idle") {
      return;
    }
    return {
      messages: event.messages.filter((message) => {
        const msg = message as typeof message & { customType?: string };
        return msg.customType !== "plan-mode-context";
      }),
    };
  });

  pi.on("tool_call", async (event, ctx) => handleToolCall(event, ctx));

  pi.on("tool_result", async (event, ctx) => handleToolResult(event, ctx));

  function handleToolCall(
    event: { toolName: string; input: Record<string, unknown> },
    ctx: ExtensionContext,
  ): { block: boolean; reason: string } | undefined {
    const isRestrictedMode = state.mode === "planning" || state.mode === "write-plan";

    if (isRestrictedMode && event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      if (!isSafeCommand(command)) {
        return {
          block: true,
          reason: `Plan mode: bash command blocked (not allowlisted read-only command). Use /plan off to disable plan mode first. Command: ${command}`,
        };
      }
    }

    const isWriteTool = event.toolName === "write" || event.toolName === "edit";
    if (state.mode === "write-plan" && isWriteTool) {
      return gatePlanPath(event.toolName, event.input, ctx);
    }
    return undefined;
  }

  function gatePlanPath(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ExtensionContext,
  ): { block: boolean; reason: string } | undefined {
    const rawPath = typeof input.path === "string" ? input.path : "";
    const { absolutePath, insidePlansDir } = resolvePlanWriteTarget(ctx.cwd, rawPath);

    if (!insidePlansDir) {
      return {
        block: true,
        reason: `Write-plan mode: ${toolName} restricted to plans/ directory. Resolved path: ${absolutePath}`,
      };
    }
    return undefined;
  }

  function handleToolResult(
    event: {
      toolName: string;
      input: Record<string, unknown>;
      content: unknown;
    },
    ctx: ExtensionContext,
  ): void {
    detectPlanWrite(event);
    detectAutoTransition(event, ctx);
  }

  function detectPlanWrite(event: { toolName: string; input: Record<string, unknown> }): void {
    const isWriteOrEdit = event.toolName === "write" || event.toolName === "edit";
    if (state.mode !== "write-plan" || !isWriteOrEdit) {
      return;
    }
    const targetPath = typeof event.input?.path === "string" ? event.input.path : "";
    if (targetPath.includes("PLAN.md")) {
      state.planWritten = true;
      persistState(pi, state);
    }
  }

  function detectAutoTransition(
    event: { toolName: string; content: unknown },
    ctx: ExtensionContext,
  ): void {
    if (event.toolName !== "ask_user_question") {
      return;
    }
    const resultText = extractContentText(event.content);
    if (!resultText) {
      return;
    }

    if (state.mode === "planning") {
      applyPlanningTransition(resultText, ctx);
    } else if (state.mode === "write-plan") {
      applyWritePlanTransition(resultText, ctx);
    }
  }

  function applyPlanningTransition(resultText: string, ctx: ExtensionContext): void {
    if (resultText.includes("Write the plan")) {
      transitionTo("write-plan", state, pi, ctx);
      pi.sendUserMessage("Write the plan document now.", {
        deliverAs: "followUp",
      });
    } else if (resultText.includes("Exit plan mode")) {
      transitionTo("idle", state, pi, ctx);
      ctx.ui.notify("Plan mode disabled. Full access restored.", "info");
    }
  }

  function applyWritePlanTransition(resultText: string, ctx: ExtensionContext): void {
    if (resultText.includes("Execute the plan")) {
      transitionTo("executing", state, pi, ctx);
      pi.sendUserMessage("Begin executing the plan.", {
        deliverAs: "followUp",
      });
    } else if (resultText.includes("Refine the plan")) {
      transitionTo("planning", state, pi, ctx);
      ctx.ui.notify("Returned to planning mode for refinement.", "info");
    } else if (resultText.includes("Exit plan mode")) {
      transitionTo("idle", state, pi, ctx);
      ctx.ui.notify("Plan mode disabled. Full access restored.", "info");
    }
  }

  pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  function notifyStatus(ctx: ExtensionContext): void {
    const lines = [
      `mode: ${state.mode}`,
      `ticket: ${state.ticketId ?? "(none)"}`,
      `planPath: ${state.planPath ?? "(none)"}`,
      `planWritten: ${state.planWritten ? "yes" : "no"}`,
    ];
    ctx.ui.notify(`Plan mode status:\n${lines.join("\n")}`, "info");
  }
}

function promptForCurrentMode(state: PlanModeState): string {
  switch (state.mode) {
    case "planning":
      return getPlanningPrompt(state);
    case "write-plan":
      return getWritePlanPrompt(state);
    case "executing":
      return getExecutingPrompt(state);
    case "idle":
      return "";
    default:
      return "";
  }
}

function normalizeArgs(args: unknown): string[] {
  if (Array.isArray(args)) {
    return args.map(String).filter(Boolean);
  }
  if (typeof args === "string") {
    return args.trim().length > 0 ? args.trim().split(/\s+/) : [];
  }
  return [];
}

function extractContentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return content
    .filter(
      (block): block is { type: string; text?: string } =>
        typeof block === "object" && block !== null,
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n");
}

function normalizePlanId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(normalized)) return undefined;
  return normalized;
}
