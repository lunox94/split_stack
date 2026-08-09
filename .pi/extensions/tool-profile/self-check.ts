import assert from "node:assert/strict";
import {
  LEAN_ONLY_TOOL_NAMES,
  SOLO_TOOL_NAMES,
  TEAM_TOOL_NAMES,
  parseTeamRouting,
  suppressedTools,
} from "./policy.ts";

const solo = parseTeamRouting(`
# Pi Agents Team Orchestrator Contract
## Routing mode: solo
Active worker count in this session snapshot: 0.
`);
assert.deepEqual(solo, { activeWorkers: 0, mode: "solo" });

const soloSuppressed = suppressedTools("lean", solo);
for (const name of [...LEAN_ONLY_TOOL_NAMES, ...TEAM_TOOL_NAMES]) {
  assert(soloSuppressed.has(name), `${name} should be suppressed in idle solo mode`);
}
for (const name of SOLO_TOOL_NAMES) {
  assert(!soloSuppressed.has(name), `${name} should be active in solo mode`);
}

const soloWithWorker = parseTeamRouting(`
# Pi Agents Team Orchestrator Contract
## Routing mode: solo
Active worker count in this session snapshot: 1.
`);
const workerSuppressed = suppressedTools("lean", soloWithWorker);
assert(workerSuppressed.has("delegate_task"));
assert(!workerSuppressed.has("agent_status"));

const team = parseTeamRouting(`
# Pi Agents Team Orchestrator Contract
## Available worker profiles
Active worker count in this session snapshot: 0.
`);
assert.deepEqual(team, { activeWorkers: 0, mode: "team" });
assert(!suppressedTools("lean", team).has("delegate_task"));
for (const name of SOLO_TOOL_NAMES) {
  assert(suppressedTools("lean", team).has(name), `${name} should be suppressed in team mode`);
  assert(
    suppressedTools("full", team).has(name),
    `${name} should stay suppressed in full team mode`,
  );
}
for (const name of TEAM_TOOL_NAMES) {
  assert(
    suppressedTools("full", solo).has(name),
    `${name} should stay suppressed in full solo mode`,
  );
}
assert(!suppressedTools("full", solo).has("subagent"));

console.log("tool-profile self-check passed");
