/** Block team delegation when source placeholders or generated fingerprints are stale. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const SOURCE_ROOTS = [
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

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else {
      files.push(path);
    }
  };
  for (const path of SOURCE_ROOTS) visit(join(root, path));
  return files.sort();
}

function currentFingerprint(root: string): string {
  const hasher = createHash("sha256");
  for (const path of sourceFiles(root)) {
    hasher.update(relative(root, path));
    hasher.update(readFileSync(path));
  }
  return hasher.digest("hex");
}

function invalidReason(root: string): string | undefined {
  const files = sourceFiles(root);
  const unresolvedMarker = ["<!-- SCAFFOLD", ":BEGIN"].join("");
  if (files.some((path) => readFileSync(path, "utf8").includes(unresolvedMarker))) {
    return "required scaffold placeholders remain";
  }
  const configPath = join(root, ".pi/agent/agents-team.json");
  if (!existsSync(configPath)) return "generated team config is missing";
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      enabled?: boolean;
      roles?: Record<string, { prompt?: string }>;
    };
    if (!config.enabled) return "generated team config is disabled";
    const fingerprintPath = join(root, ".pi/agent/source-fingerprint");
    if (!existsSync(fingerprintPath)) return "generated team source fingerprint is missing";
    if (readFileSync(fingerprintPath, "utf8").trim() !== currentFingerprint(root)) {
      return "generated team config is stale";
    }
    for (const [id, role] of Object.entries(config.roles ?? {})) {
      if (!role.prompt || !existsSync(join(root, role.prompt))) return `generated bundle is missing for ${id}`;
    }
  } catch {
    return "generated team config is invalid JSON";
  }
  return undefined;
}

export default function teamPromptGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "delegate_task") return;
    const reason = invalidReason(ctx.cwd);
    if (!reason) return;
    return {
      block: true,
      reason: `Pi team delegation blocked: ${reason}. Run task agent:team:generate, task agent:validate, then /reload.`,
    };
  });
}
