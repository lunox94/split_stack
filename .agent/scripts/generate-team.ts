#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

interface SourceRole {
  id: string;
  role: string;
  model: string;
  expertise: string[];
  writable: boolean;
}

interface TeamSource {
  model_slots: Record<string, string>;
  runtime: { routing_mode: string };
  roles: SourceRole[];
}

const root = process.env.WORKSPACE_ROOT ?? process.cwd();
const teamSourcePath = join(root, ".agent/teams.yaml");
const teamOutputPath = join(root, ".pi/agent/agents-team.json");
const bundleDirectory = join(root, ".pi/agent/bundles");
const bundleManifestPath = join(root, ".pi/agent/generated-bundles.json");
const placeholderPattern = /<!-- SCAFFOLD:BEGIN/g;

function sourceFiles(): string[] {
  const roots = [
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
  const files: string[] = [];
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else if (!path.includes("/logs/") && !path.includes("/sessions/")) {
      files.push(path);
    }
  };
  for (const path of roots) visit(join(root, path));
  return files.sort();
}

function unresolvedFiles(): string[] {
  return sourceFiles()
    .filter((path) => readFileSync(path, "utf8").match(placeholderPattern))
    .map((path) => relative(root, path));
}

function loadSource(): TeamSource {
  const source = Bun.YAML.parse(readFileSync(teamSourcePath, "utf8")) as TeamSource;
  if (!source || !source.model_slots || !source.runtime || !Array.isArray(source.roles)) {
    throw new Error(".agent/teams.yaml must define model_slots, runtime, and roles");
  }
  if (source.runtime.routing_mode !== "solo" && source.runtime.routing_mode !== "team") {
    throw new Error(".agent/teams.yaml runtime.routing_mode must be solo or team");
  }
  const ids = new Set<string>();
  for (const role of source.roles) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(role.id)) throw new Error(`Unsafe role id: ${role.id}`);
    if (ids.has(role.id)) throw new Error(`Duplicate role id: ${role.id}`);
    if (!source.model_slots[role.model]) throw new Error(`Unknown model slot ${role.model} for ${role.id}`);
    if (!Array.isArray(role.expertise) || role.expertise.length === 0) {
      throw new Error(`Role ${role.id} needs at least one expertise file`);
    }
    ids.add(role.id);
  }
  return source;
}

function bundleFor(role: SourceRole): string {
  const sections = [
    `# ${role.id} role context`,
    `You are **${role.id}**: ${role.role}`,
    "This generated bundle is authoritative. Do not load role policy from the task worktree or query Hermes memory.",
  ];
  for (const expertise of role.expertise) {
    const path = resolve(root, expertise);
    if (!existsSync(path)) throw new Error(`Missing expertise for ${role.id}: ${expertise}`);
    const content = readFileSync(path, "utf8").trim();
    if (!content) throw new Error(`Empty expertise for ${role.id}: ${expertise}`);
    sections.push(`<!-- BEGIN expertise:${expertise} -->\n${content}\n<!-- END expertise:${expertise} -->`);
  }
  sections.push(
    `## Completion contract\n\nEnd with exactly one \`<final_answer>...</final_answer>\` element containing: outcome, files changed, validation evidence, and remaining risks. The orchestrator must repeat that shape in the delegation task's \`expectedOutput\`.`,
  );
  return `${sections.join("\n\n")}\n`;
}

function thinkingLevel(slot: string): string {
  if (slot === "fast_model") return "low";
  if (slot === "high_reasoning_model" || slot === "orchestrator_model") return "high";
  return "medium";
}

function buildArtifacts() {
  const source = loadSource();
  const roles: Record<string, unknown> = {};
  const bundles = new Map<string, string>();
  for (const role of source.roles) {
    const tools = role.writable
      ? ["bash", "edit", "find", "grep", "ls", "read", "write"]
      : ["bash", "find", "grep", "ls", "read"];
    roles[role.id] = {
      whenToUse: role.role.endsWith(".") ? role.role : `${role.role}.`,
      model: source.model_slots[role.model],
      thinkingLevel: thinkingLevel(role.model),
      access: { tools, write: role.writable },
      prompt: `.pi/agent/bundles/${role.id}.md`,
    };
    bundles.set(role.id, bundleFor(role));
  }

  const hasher = createHash("sha256");
  for (const path of sourceFiles()) {
    hasher.update(relative(root, path));
    hasher.update(readFileSync(path));
  }
  return {
    bundles,
    fingerprint: hasher.digest("hex"),
    config: {
      schemaVersion: 4,
      scaffoldVersion: 3,
      enabled: true,
      routingMode: source.runtime.routing_mode,
      workerAccess: { allowPathsOutsideProject: true },
      display: { cost: true },
      roles,
    },
  };
}

function serialized(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ownedBundleFiles(): string[] {
  if (!existsSync(bundleManifestPath)) {
    throw new Error("Generated bundle manifest is missing; restore .pi/agent/generated-bundles.json");
  }
  const manifest = JSON.parse(readFileSync(bundleManifestPath, "utf8")) as {
    schemaVersion?: number;
    files?: unknown;
  };
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error("Generated bundle manifest is invalid");
  }
  const files = manifest.files;
  if (files.some((file) => typeof file !== "string" || !/^[a-z0-9][a-z0-9-]*\.md$/.test(file))) {
    throw new Error("Generated bundle manifest contains an unsafe filename");
  }
  return files as string[];
}

function check(): void {
  const artifacts = buildArtifacts();
  if (!existsSync(teamOutputPath) || readFileSync(teamOutputPath, "utf8") !== serialized(artifacts.config)) {
    throw new Error("Generated team config is stale; run `task agent:team:generate`");
  }
  const fingerprintPath = join(root, ".pi/agent/source-fingerprint");
  if (!existsSync(fingerprintPath) || readFileSync(fingerprintPath, "utf8") !== `${artifacts.fingerprint}\n`) {
    throw new Error("Generated team source fingerprint is stale; run `task agent:team:generate`");
  }
  const expected = [...artifacts.bundles.keys()].map((id) => `${id}.md`).sort();
  if (JSON.stringify(ownedBundleFiles().sort()) !== JSON.stringify(expected)) {
    throw new Error("Generated team bundle manifest is stale; run `task agent:team:generate`");
  }
  const actual = existsSync(bundleDirectory)
    ? readdirSync(bundleDirectory).filter((path) => path.endsWith(".md")).sort()
    : [];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Generated team bundle set is stale; run `task agent:team:generate`");
  }
  for (const [id, content] of artifacts.bundles) {
    if (readFileSync(join(bundleDirectory, `${id}.md`), "utf8") !== content) {
      throw new Error(`Generated bundle is stale: ${id}`);
    }
  }
}

function generate(): void {
  const unresolved = unresolvedFiles();
  if (unresolved.length > 0) {
    throw new Error(
      `Cannot enable team mode: unresolved scaffold placeholders in ${unresolved.length} file(s):\n${unresolved
        .map((path) => `  - ${path}`)
        .join("\n")}`,
    );
  }
  const artifacts = buildArtifacts();
  mkdirSync(bundleDirectory, { recursive: true });
  const owned = ownedBundleFiles();
  const actual = readdirSync(bundleDirectory).filter((path) => path.endsWith(".md")).sort();
  const unknown = actual.filter((path) => !owned.includes(path));
  if (unknown.length > 0) {
    throw new Error(`Cannot regenerate: unknown bundle files are not scaffold-owned:\n${unknown.map((path) => `  - ${path}`).join("\n")}`);
  }
  const expected = [...artifacts.bundles.keys()].map((id) => `${id}.md`).sort();
  for (const stale of owned.filter((path) => !expected.includes(path))) {
    const path = join(bundleDirectory, stale);
    if (existsSync(path)) unlinkSync(path);
  }
  for (const [id, content] of artifacts.bundles) {
    writeFileSync(join(bundleDirectory, `${id}.md`), content);
  }
  writeFileSync(bundleManifestPath, serialized({ schemaVersion: 1, files: expected }));
  mkdirSync(dirname(teamOutputPath), { recursive: true });
  writeFileSync(teamOutputPath, serialized(artifacts.config));
  writeFileSync(join(root, ".pi/agent/source-fingerprint"), `${artifacts.fingerprint}\n`);
  console.log(`Generated ${Object.keys(artifacts.config.roles).length} flat team roles and bundles.`);
}

try {
  if (process.argv.includes("--check")) check();
  else generate();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
