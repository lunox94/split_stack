#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.env.WORKSPACE_ROOT ?? process.cwd();
const classes: Record<string, string[]> = {
  always: ["AGENTS.md", "CONTEXT.md"],
  orchestrator: [".agent/README.md", ".agent/skill-policy.yaml", ".agent/teams.yaml"],
  "worker-bundles": [".pi/agent/bundles"],
  "on-demand": ["docs", ".agent/expertise"],
};

function filesAt(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).sort().flatMap((child) => filesAt(join(path, child)));
}

const report: Record<string, { bytes: number; estimatedTokens: number; files: string[] }> = {};
for (const [loadingClass, paths] of Object.entries(classes)) {
  const files = paths.flatMap((path) => filesAt(join(root, path))).sort();
  const bytes = files.reduce((sum, path) => sum + readFileSync(path).byteLength, 0);
  report[loadingClass] = {
    bytes,
    estimatedTokens: Math.ceil(bytes / 4),
    files: files.map((path) => relative(root, path)),
  };
}

const baselinePath = join(root, ".agent/corpus-baseline.json");
if (process.argv.includes("--write-baseline")) {
  writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote corpus baseline: ${relative(root, baselinePath)}`);
} else if (process.argv.includes("--check")) {
  if (!existsSync(baselinePath)) {
    console.error("Agent corpus baseline is missing. Run task agent:corpus:baseline after customization.");
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (baseline.status === "uninitialized") {
    console.error("Agent corpus baseline is uninitialized. Run task agent:corpus:baseline after customization.");
    process.exit(1);
  }
  if (JSON.stringify(baseline) !== JSON.stringify(report)) {
    console.error("Agent corpus baseline changed. Review the report, then refresh the committed baseline intentionally.");
    process.exit(1);
  }
  console.log("Agent corpus baseline current.");
} else {
  console.log(JSON.stringify(report, null, 2));
}
