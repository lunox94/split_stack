#!/usr/bin/env bun

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

interface SkillSelection {
  name: string;
  coordination: "orchestrator-only" | "orchestrator-parallel" | "worker-brief-compatible";
}

interface SkillPolicy {
  selected_skills?: SkillSelection[];
}

interface SkillsLock {
  matt_pocock_skills?: {
    resolved_commit?: string;
  };
}

const root = process.env.WORKSPACE_ROOT ?? process.cwd();
const policyPath = join(root, ".agent/skill-policy.yaml");
const vendorRepository = join(root, ".agent/vendor/matt-pocock-skills");
const vendorRoot = join(vendorRepository, "skills");
const selectedRoot = join(root, ".agent/vendor/matt-pocock-skills-selected");

function gitOutput(args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", vendorRepository, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Cannot verify pinned Matt Pocock checkout: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function verifyPinnedCheckout(): void {
  const lock = Bun.YAML.parse(readFileSync(join(root, ".agent/skills-lock.yaml"), "utf8")) as SkillsLock;
  const expected = lock.matt_pocock_skills?.resolved_commit;
  if (!expected || !/^[0-9a-f]{40}$/.test(expected)) {
    throw new Error(".agent/skills-lock.yaml needs a full resolved_commit");
  }
  const actual = gitOutput(["rev-parse", "HEAD"]);
  if (actual !== expected) throw new Error(`Pinned skill checkout is ${actual}; expected ${expected}`);
  if (gitOutput(["status", "--porcelain"]) !== "") {
    throw new Error("Pinned Matt Pocock skill checkout has local modifications");
  }
}

function treeDigest(directory: string): string {
  const hasher = createHash("sha256");
  const visit = (path: string): void => {
    for (const entry of readdirSync(path).sort()) {
      const child = join(path, entry);
      const stat = statSync(child);
      if (stat.isDirectory()) visit(child);
      else {
        hasher.update(relative(directory, child));
        hasher.update(readFileSync(child));
      }
    }
  };
  visit(directory);
  return hasher.digest("hex");
}

function findSkill(name: string): string {
  const matches: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      if (!statSync(path).isDirectory()) continue;
      const skillFile = join(path, "SKILL.md");
      if (existsSync(skillFile)) {
        const content = readFileSync(skillFile, "utf8");
        if (content.match(/^name:\s*(.+)$/m)?.[1]?.trim() === name) {
          matches.push(path);
        }
        continue;
      }
      visit(path);
    }
  };
  visit(vendorRoot);
  if (matches.length !== 1) {
    throw new Error(`Selected skill ${name} resolved to ${matches.length} directories in the pinned checkout`);
  }
  return matches[0]!;
}

if (!existsSync(vendorRoot)) {
  throw new Error("Pinned Matt Pocock skill checkout is missing; run `task agent:skills:install`");
}
verifyPinnedCheckout();

const policy = Bun.YAML.parse(readFileSync(policyPath, "utf8")) as SkillPolicy;
const selections = policy.selected_skills ?? [];
if (selections.length === 0) throw new Error(".agent/skill-policy.yaml must select at least one upstream skill");
const names = selections.map((selection) => selection.name);
if (names.some((name) => !/^[a-z0-9][a-z0-9-]*$/.test(name))) {
  throw new Error("Selected upstream skill names must use lowercase letters, numbers, and hyphens");
}
const coordinationModes = new Set([
  "orchestrator-only",
  "orchestrator-parallel",
  "worker-brief-compatible",
]);
if (selections.some((selection) => !coordinationModes.has(selection.coordination))) {
  throw new Error("Selected upstream skills must declare a supported coordination mode");
}
if (new Set(names).size !== names.length) throw new Error("Selected upstream skill names must be unique");

function checkSelection(): void {
  if (!existsSync(selectedRoot)) throw new Error("Selected upstream skill projection is missing");
  const expectedEntries = [...names].sort();
  const actualEntries = readdirSync(selectedRoot).sort();
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error("Selected upstream skill projection does not match the project allowlist");
  }
  for (const name of expectedEntries) {
    if (treeDigest(findSkill(name)) !== treeDigest(join(selectedRoot, name))) {
      throw new Error(`Selected upstream skill ${name} differs from the pinned checkout`);
    }
  }
}

if (process.argv.includes("--check")) {
  checkSelection();
  console.log(`Verified ${selections.length} selected upstream skills against the pinned checkout.`);
  process.exit(0);
}

const staging = `${selectedRoot}.tmp-${process.pid}`;
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
for (const selection of selections) {
  cpSync(findSkill(selection.name), join(staging, selection.name), { recursive: true });
}

const backup = `${selectedRoot}.previous-${process.pid}`;
if (existsSync(selectedRoot)) renameSync(selectedRoot, backup);
try {
  renameSync(staging, selectedRoot);
  rmSync(backup, { recursive: true, force: true });
} catch (error) {
  if (existsSync(backup) && !existsSync(selectedRoot)) renameSync(backup, selectedRoot);
  throw error;
}

checkSelection();

console.log(`Exposed ${selections.length} explicitly selected upstream skills to Pi.`);
