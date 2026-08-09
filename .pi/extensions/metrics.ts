/** Passive, metadata-only workflow metrics. No model calls and no prompt content. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default function metrics(pi: ExtensionAPI): void {
  let sessionId = "unknown";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let contextBytes = 0;
  let provider: string | undefined;
  let model: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
  });

  pi.on("context", (event) => {
    contextBytes = Buffer.byteLength(JSON.stringify(event.messages), "utf8");
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    inputTokens += event.message.usage.input;
    outputTokens += event.message.usage.output;
    cacheReadTokens += event.message.usage.cacheRead;
    cacheWriteTokens += event.message.usage.cacheWrite;
    provider = event.message.provider;
    model = event.message.model;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const directory = join(ctx.cwd, ".agent/metrics");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, `${sessionId}.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          sessionId,
          provider,
          model,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          contextBytes,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  });
}
