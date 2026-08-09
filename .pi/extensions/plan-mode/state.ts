import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyToolRestrictions, type PlanMode } from "./tools.ts";

export type { PlanMode };

export interface PlanModeState {
  mode: PlanMode;
  ticketId: string | null;
  planTitle: string | null;
  planPath: string | null;
  planWritten: boolean;
  explorationNotes: string[];
}

export const INITIAL_STATE: PlanModeState = {
  mode: "idle",
  ticketId: null,
  planTitle: null,
  planPath: null,
  planWritten: false,
  explorationNotes: [],
};

type CustomEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
};

export function persistState(pi: ExtensionAPI, state: PlanModeState): void {
  pi.appendEntry("plan-mode-state", {
    mode: state.mode,
    ticketId: state.ticketId,
    planTitle: state.planTitle,
    planPath: state.planPath,
    planWritten: state.planWritten,
    explorationNotes: [...state.explorationNotes],
  });
}

export function restoreState(ctx: ExtensionContext): PlanModeState | null {
  const entries = ctx.sessionManager.getEntries() as CustomEntry[];
  const lastStateEntry = entries
    .filter((entry) => entry.type === "custom" && entry.customType === "plan-mode-state")
    .pop();

  return toPlanModeState(lastStateEntry?.data);
}

export function transitionTo(
  mode: PlanMode,
  state: PlanModeState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  state.mode = mode;
  applyToolRestrictions(pi, mode);
  persistState(pi, state);
  updateStatus(state, ctx);
}

export function updateStatus(state: PlanModeState, ctx: ExtensionContext): void {
  const theme = ctx.ui.theme;
  switch (state.mode) {
    case "planning":
      ctx.ui.setStatus(
        "plan-mode",
        theme.fg("warning", `⏸ plan: ${state.ticketId ?? "exploring"}`),
      );
      break;
    case "write-plan":
      ctx.ui.setStatus("plan-mode", theme.fg("accent", `✏ writing: ${state.ticketId ?? "plan"}`));
      break;
    case "executing":
      ctx.ui.setStatus("plan-mode", theme.fg("success", `▶ exec: ${state.ticketId ?? "plan"}`));
      break;
    case "idle":
      ctx.ui.setStatus("plan-mode", undefined);
      break;
    default:
      break;
  }
}

function toPlanModeState(data: unknown): PlanModeState | null {
  if (!isRecord(data) || !isPlanMode(data.mode)) {
    return null;
  }

  return {
    mode: data.mode,
    ticketId: nullableString(data.ticketId),
    planTitle: nullableString(data.planTitle),
    planPath: nullableString(data.planPath),
    planWritten: typeof data.planWritten === "boolean" ? data.planWritten : false,
    explorationNotes: Array.isArray(data.explorationNotes)
      ? data.explorationNotes.filter((note): note is string => typeof note === "string")
      : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const VALID_MODES: ReadonlySet<string> = new Set(["idle", "planning", "write-plan", "executing"]);

function isPlanMode(value: unknown): value is PlanMode {
  return typeof value === "string" && VALID_MODES.has(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
