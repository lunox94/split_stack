import * as fs from "node:fs";
import * as path from "node:path";

const BUILTIN_TOOL_NAMES = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);
const READ_ONLY_TOOL_NAMES = new Set(["find", "grep", "ls", "read"]);

export type AgentScope = "project";

export interface AgentConfig {
  description: string;
  extensions: string[];
  filePath: string;
  model?: string;
  name: string;
  source: "project";
  systemPrompt: string;
  thinkingLevel?: string;
  tools: string[];
  write: boolean;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

type RawRole = {
  access?: {
    extensions?: unknown;
    tools?: unknown;
    write?: unknown;
  };
  model?: unknown;
  prompt?: unknown;
  thinkingLevel?: unknown;
  whenToUse?: unknown;
};

type RawConfig = {
  roles?: Record<string, RawRole>;
};

function findNearestConfig(cwd: string): { configPath: string; projectRoot: string } | null {
  let currentDir = path.resolve(cwd);

  while (true) {
    const configPath = path.join(currentDir, ".pi", "agent", "agents-team.json");
    if (fs.existsSync(configPath)) return { configPath, projectRoot: currentDir };

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function loadRole(name: string, rawRole: RawRole, projectRoot: string): AgentConfig {
  if (typeof rawRole.prompt !== "string" || !rawRole.prompt.trim()) {
    throw new Error(`Role "${name}" must declare a non-empty project-root-relative prompt path.`);
  }

  const promptPath = path.resolve(projectRoot, rawRole.prompt);
  if (!isInsideRoot(promptPath, projectRoot)) {
    throw new Error(`Role "${name}" prompt escapes the project root: ${rawRole.prompt}`);
  }

  let realPromptPath: string;
  try {
    realPromptPath = fs.realpathSync.native(promptPath);
  } catch {
    throw new Error(`Role "${name}" prompt is not readable: ${promptPath}`);
  }
  const realProjectRoot = fs.realpathSync.native(projectRoot);
  if (!isInsideRoot(realPromptPath, realProjectRoot)) {
    throw new Error(`Role "${name}" prompt resolves outside the project root: ${rawRole.prompt}`);
  }

  const systemPrompt = fs.readFileSync(realPromptPath, "utf-8");
  if (!systemPrompt.trim()) throw new Error(`Role "${name}" prompt is empty: ${realPromptPath}`);

  return {
    description: typeof rawRole.whenToUse === "string" ? rawRole.whenToUse : name,
    extensions: stringArray(rawRole.access?.extensions).map((extension) =>
      path.resolve(projectRoot, extension),
    ),
    filePath: realPromptPath,
    model: typeof rawRole.model === "string" ? rawRole.model : undefined,
    name,
    source: "project",
    systemPrompt,
    thinkingLevel: typeof rawRole.thinkingLevel === "string" ? rawRole.thinkingLevel : undefined,
    tools: stringArray(rawRole.access?.tools).filter((tool) => BUILTIN_TOOL_NAMES.has(tool)),
    write: rawRole.access?.write === true,
  };
}

export function discoverAgents(cwd: string, _scope: AgentScope): AgentDiscoveryResult {
  const nearest = findNearestConfig(cwd);
  if (!nearest) return { agents: [], projectAgentsDir: null };

  let parsed: RawConfig;
  try {
    parsed = JSON.parse(fs.readFileSync(nearest.configPath, "utf-8")) as RawConfig;
  } catch (error) {
    throw new Error(`Cannot load Pi team config ${nearest.configPath}: ${String(error)}`);
  }

  if (!parsed.roles || Object.keys(parsed.roles).length === 0) {
    throw new Error(`Pi team config has no roles: ${nearest.configPath}`);
  }

  const agents = Object.entries(parsed.roles).map(([name, rawRole]) =>
    loadRole(name, rawRole, nearest.projectRoot),
  );

  return {
    agents,
    projectAgentsDir: path.dirname(nearest.configPath),
  };
}

export function toolsForAgent(agent: AgentConfig, readOnly: boolean): string[] {
  if (!agent.write || readOnly) {
    return agent.tools.filter((tool) => READ_ONLY_TOOL_NAMES.has(tool));
  }

  return agent.tools;
}

export function buildSubagentProcessArgs(agent: AgentConfig, readOnly: boolean): string[] {
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-skills",
    "--no-themes",
    "--approve",
  ];
  if (agent.model) args.push("--model", agent.model);
  if (agent.thinkingLevel) args.push("--thinking", agent.thinkingLevel);
  for (const extension of agent.extensions) args.push("--extension", extension);
  const tools = toolsForAgent(agent, readOnly);
  if (tools.length > 0) args.push("--tools", tools.join(","));
  return args;
}

function findGitWorktreeRoot(cwd: string): string | undefined {
  let currentDir: string;
  try {
    currentDir = fs.realpathSync.native(cwd);
  } catch {
    return undefined;
  }

  while (true) {
    if (fs.existsSync(path.join(currentDir, ".git"))) return currentDir;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return undefined;
    currentDir = parentDir;
  }
}

export function parallelWriteError(
  tasks: Array<{ agent: string; cwd?: string; readOnly?: boolean }>,
  agents: AgentConfig[],
): string | undefined {
  const worktrees = new Set<string>();

  for (const task of tasks) {
    const agent = agents.find((candidate) => candidate.name === task.agent);
    if (task.readOnly !== false || !agent?.write) continue;
    if (!task.cwd) return `Writable parallel task for ${task.agent} requires its own worktree cwd.`;

    const worktree = findGitWorktreeRoot(task.cwd);
    if (!worktree) {
      return `Writable parallel task for ${task.agent} requires a valid Git worktree cwd.`;
    }
    if (worktrees.has(worktree)) {
      return `Writable parallel tasks cannot share Git worktree ${worktree}.`;
    }
    worktrees.add(worktree);
  }

  return undefined;
}
