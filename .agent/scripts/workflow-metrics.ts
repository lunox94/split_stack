#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.env.WORKSPACE_ROOT ?? process.cwd();
const metricsDirectory = join(root, ".agent/metrics");

function metricFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).sort().flatMap((child) => metricFiles(join(path, child)));
}

const records = metricFiles(metricsDirectory)
  .filter((path) => path.endsWith(".json"))
  .flatMap((path) => {
    try {
      return [JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>];
    } catch {
      return [];
    }
  });

const summary = {
  sessions: records.length,
  inputTokens: records.reduce((sum, row) => sum + Number(row.inputTokens ?? 0), 0),
  outputTokens: records.reduce((sum, row) => sum + Number(row.outputTokens ?? 0), 0),
  cacheReadTokens: records.reduce((sum, row) => sum + Number(row.cacheReadTokens ?? 0), 0),
  cacheWriteTokens: records.reduce((sum, row) => sum + Number(row.cacheWriteTokens ?? 0), 0),
  contextBytes: records.reduce((sum, row) => sum + Number(row.contextBytes ?? 0), 0),
};
console.log(JSON.stringify(summary, null, 2));
