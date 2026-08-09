#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.env.WORKSPACE_ROOT ?? process.cwd();
const scanRoots = [
  "AGENTS.md",
  "CONTEXT.md",
  ".agent/config.yaml",
  ".agent/teams.yaml",
  ".agent/skill-policy.yaml",
  ".agent/skills-lock.yaml",
  ".agent/expertise",
  ".agent/prompts",
  ".agent/integrations.md",
  ".agent/memory.md",
  "docs",
  ".pi/extensions",
  ".pi/packages/fixed-layout",
  ".github/workflows/agent-harness.yml",
];
const unresolved: string[] = [];

function visit(path: string): void {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    for (const child of readdirSync(path).sort()) visit(join(path, child));
    return;
  }
  if (readFileSync(path, "utf8").includes("<!-- SCAFFOLD:BEGIN")) unresolved.push(relative(root, path));
}

for (const path of scanRoots) visit(join(root, path));

if (unresolved.length > 0) {
  console.error(`Agent scaffold has unresolved placeholders in ${unresolved.length} file(s):`);
  for (const path of unresolved) console.error(`  - ${path}`);
  process.exit(1);
}

const check = Bun.spawnSync(["bun", ".agent/scripts/generate-team.ts", "--check"], {
  cwd: root,
  stderr: "pipe",
  stdout: "pipe",
});
if (check.exitCode !== 0) {
  process.stderr.write(check.stderr.toString());
  process.exit(check.exitCode);
}

const corpus = Bun.spawnSync(["bun", ".agent/scripts/corpus-report.ts", "--check"], {
  cwd: root,
  stderr: "pipe",
  stdout: "pipe",
});
if (corpus.exitCode !== 0) {
  process.stderr.write(corpus.stderr.toString());
  process.exit(corpus.exitCode);
}

const skillCheckout = join(root, ".agent/vendor/matt-pocock-skills");
const selectedSkills = join(root, ".agent/vendor/matt-pocock-skills-selected");
if (existsSync(skillCheckout) || existsSync(selectedSkills)) {
  const skills = Bun.spawnSync(["bun", ".agent/scripts/select-skills.ts", "--check"], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (skills.exitCode !== 0) {
    process.stderr.write(skills.stderr.toString());
    process.exit(skills.exitCode);
  }
}

for (const selfCheck of [
  ".pi/extensions/subagent/self-check.ts",
  ".pi/extensions/tool-profile/self-check.ts",
]) {
  const result = Bun.spawnSync(["bun", selfCheck], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr.toString());
    process.exit(result.exitCode);
  }
}

console.log("Agent scaffold valid: required placeholders resolved and generated team artifacts are current.");
