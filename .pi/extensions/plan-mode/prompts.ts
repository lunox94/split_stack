import type { PlanModeState } from "./state.ts";

const projectConvention = `
Use plans/GH-<issue-number>/PLAN.md for GitHub-linked work and
plans/LOCAL-<kebab-slug>/PLAN.md for an approved local-only plan. Keep the plan
decision-ready and link the issue when one exists. An issue is needed only for
multi-session or tracker-visible work. Reading GitHub is allowed, but creating
or changing tracker state requires explicit user approval. Do not duplicate
architecture or domain truth already owned by README.md, CONTEXT.md,
IMPLEMENTATION_DECISIONS.md, or docs/adr/.`;

export function getPlanningPrompt(state: PlanModeState): string {
  const planHint = state.ticketId
    ? `The plan or tracker identifier is ${state.ticketId}.`
    : "Ask the user for a safe plan or tracker identifier early in exploration.";

  return `[PLAN MODE — EXPLORATION PHASE]

You are in a read-only exploration phase for safe code analysis and plan authoring.

## Restrictions
- Available tools: read, bash (read-only commands only), grep, find, ls, todo, ask_user_question
- File modifications are disabled
- Bash is restricted to an allowlist of read-only commands

## Goals
1. Explore relevant code, tests, history, and documentation.
2. Use ask_user_question for material choices instead of guessing.
3. Track concrete implementation units with todo when useful.
4. Record evidence, risks, dependencies, and alternatives.

${planHint}
${projectConvention}

When exploration is complete, call ask_user_question with these choices:
- "Write the plan"
- "Continue exploring"
- "Exit plan mode"

Only the returned user choice may transition the state. Do not modify files.`;
}

export function getWritePlanPrompt(state: PlanModeState): string {
  const planPath = state.planPath ?? `plans/${state.ticketId ?? "PLAN-ID"}/PLAN.md`;

  return `[PLAN MODE — WRITING PHASE]

Write and edit are enabled only under plans/. Write ${planPath} as a decision-ready plan.

Use this lean skeleton and omit empty sections:

\`\`\`markdown
# [${state.ticketId ?? "PLAN-ID"}] ${state.planTitle ?? "Short descriptive title"}

## Problem
## Proposed approach
## Alternatives considered
## Risks and unknowns
## Slicing
## Open questions
## Related work
\`\`\`

${projectConvention}

After writing, call ask_user_question with these choices:
- "Execute the plan"
- "Refine the plan"
- "Exit plan mode"

The user's returned choice drives the transition. The user may also explicitly invoke /plan execute.`;
}

export function getExecutingPrompt(state: PlanModeState): string {
  const planPath = state.planPath ?? "the approved plan";
  return `[PLAN MODE — EXECUTION PHASE]

Full tool access is restored. Execute ${planPath} in dependency order. Keep todo status current when the todo tool is available, validate each completed slice, and ask the user when a new material choice falls outside the plan. When all work is verified, provide the integrated outcome and remaining risks.`;
}
