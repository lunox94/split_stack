import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSubagentProcessArgs,
  discoverAgents,
  parallelWriteError,
  toolsForAgent,
} from "./roles.ts";

const root = mkdtempSync(join(tmpdir(), "pi-subagent-check-"));
try {
  const configDirectory = join(root, ".pi/agent");
  const bundleDirectory = join(configDirectory, "bundles");
  mkdirSync(bundleDirectory, { recursive: true });
  writeFileSync(join(bundleDirectory, "implementation.md"), "# Worker contract\n");
  writeFileSync(join(bundleDirectory, "verifier.md"), "# Verifier contract\n");
  writeFileSync(
    join(configDirectory, "agents-team.json"),
    `${JSON.stringify({
      roles: {
        implementation: {
          access: { tools: ["bash", "edit", "find", "grep", "ls", "read", "write"], write: true },
          prompt: ".pi/agent/bundles/implementation.md",
        },
        verifier: {
          access: { tools: ["bash", "find", "grep", "ls", "read"], write: false },
          prompt: ".pi/agent/bundles/verifier.md",
        },
      },
    })}\n`,
  );

  const agents = discoverAgents(root, "project").agents;
  const implementation = agents.find((agent) => agent.name === "implementation");
  const verifier = agents.find((agent) => agent.name === "verifier");
  assert(implementation?.write);
  assert.equal(verifier?.write, false);
  assert.deepEqual(toolsForAgent(implementation, true).sort(), ["find", "grep", "ls", "read"]);
  const args = buildSubagentProcessArgs(implementation, false);
  assert(args.includes("--no-context-files"));
  assert(args.includes("--no-skills"));
  assert.match(
    parallelWriteError([{ agent: "implementation", readOnly: false }], agents) ?? "",
    /requires its own worktree/,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("subagent self-check passed");
