import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_PATH = join(process.cwd(), ".pi", "fast-mode.json");
const DEFAULT_MODELS = ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const DEFAULT_PROVIDERS = ["openai-codex"];
const DEFAULT_SERVICE_TIER = "priority";
const STATUS_KEY = "openai-fast-mode";

type FastModeConfig = {
  enabled?: boolean;
  models?: string[];
  providers?: string[];
  serviceTier?: string;
};

type ResolvedFastModeConfig = Required<FastModeConfig>;

type ProviderPayload = {
  model?: unknown;
  service_tier?: unknown;
};

type CurrentModel = {
  id?: unknown;
  modelId?: unknown;
  provider?: unknown;
};

function isProviderPayload(payload: unknown): payload is ProviderPayload {
  return Boolean(payload) && typeof payload === "object" && !Array.isArray(payload);
}

function normalizedList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") && value.length > 0
    ? value
    : fallback;
}

function loadConfig(): ResolvedFastModeConfig {
  if (!existsSync(CONFIG_PATH)) {
    return {
      enabled: false,
      models: DEFAULT_MODELS,
      providers: DEFAULT_PROVIDERS,
      serviceTier: DEFAULT_SERVICE_TIER,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as FastModeConfig;
    return {
      enabled: parsed.enabled === true,
      models: normalizedList(parsed.models, DEFAULT_MODELS),
      providers: normalizedList(parsed.providers, DEFAULT_PROVIDERS),
      serviceTier:
        typeof parsed.serviceTier === "string" && parsed.serviceTier.length > 0
          ? parsed.serviceTier
          : DEFAULT_SERVICE_TIER,
    };
  } catch {
    return {
      enabled: false,
      models: DEFAULT_MODELS,
      providers: DEFAULT_PROVIDERS,
      serviceTier: DEFAULT_SERVICE_TIER,
    };
  }
}

function saveConfig(enabled: boolean): ResolvedFastModeConfig {
  const current = loadConfig();
  const next = {
    ...current,
    enabled,
  };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

function currentProvider(model: CurrentModel | undefined): string | undefined {
  return typeof model?.provider === "string" ? model.provider : undefined;
}

function currentModelId(
  model: CurrentModel | undefined,
  payload: ProviderPayload,
): string | undefined {
  if (typeof model?.id === "string") return model.id;
  if (typeof model?.modelId === "string") return model.modelId;
  return typeof payload.model === "string" ? payload.model : undefined;
}

function shouldUseFastMode(
  payload: ProviderPayload,
  config: ResolvedFastModeConfig,
  model: CurrentModel | undefined,
): boolean {
  return fastModeBlocker(payload, config, model) === undefined;
}

function fastModeBlocker(
  payload: ProviderPayload,
  config: ResolvedFastModeConfig,
  model: CurrentModel | undefined,
): string | undefined {
  const provider = currentProvider(model);
  const modelId = currentModelId(model, payload);

  if (!config.enabled) return "disabled";
  if (provider === undefined) return "unknown provider";
  if (modelId === undefined) return "unknown model";
  if (!config.providers.includes(provider))
    return `provider ${provider} not in ${config.providers.join(", ")}`;
  if (!config.models.includes(modelId))
    return `model ${modelId} not in ${config.models.join(", ")}`;

  return undefined;
}

function currentPayload(ctx: unknown): ProviderPayload {
  const model = (ctx as { model?: CurrentModel }).model;
  const modelId = typeof model?.id === "string" ? model.id : model?.modelId;
  return typeof modelId === "string" ? { model: modelId } : {};
}

function formatStatus(config: ResolvedFastModeConfig, model: CurrentModel | undefined): string {
  if (!config.enabled) return "fast:off";

  return fastModeBlocker(currentPayload({ model }), config, model) === undefined
    ? `fast:${config.serviceTier}`
    : "fast:idle";
}

function prependProjectBinToPath(): void {
  const binPath = join(process.cwd(), ".pi", "bin");
  const pathParts = (process.env.PATH ?? "").split(":").filter((part) => part.length > 0);
  if (pathParts.includes(binPath)) return;

  process.env.PATH = [binPath, ...pathParts].join(":");
}

function setStatus(ctx: unknown, config: ResolvedFastModeConfig): void {
  const typedCtx = ctx as {
    model?: CurrentModel;
    ui?: {
      setStatus?: (key: string, text: string | undefined) => void;
      theme?: { fg?: (name: string, text: string) => string };
    };
  };
  const ui = typedCtx.ui;
  const text = formatStatus(config, typedCtx.model);
  const color = text === `fast:${config.serviceTier}` ? "accent" : "warning";
  ui?.setStatus?.(STATUS_KEY, config.enabled ? (ui.theme?.fg?.(color, text) ?? text) : undefined);
}

function formatRuntime(
  config: ResolvedFastModeConfig,
  ctx: unknown,
  thinkingLevel: string | undefined,
): string {
  const model = (ctx as { model?: CurrentModel }).model;
  const payload = currentPayload(ctx);
  const blocker = fastModeBlocker(payload, config, model);
  const runtimeStatus = blocker === undefined ? "active" : `inactive (${blocker})`;
  const provider = currentProvider(model) ?? "unknown";
  const modelId = currentModelId(model, payload) ?? "unknown";

  return `Current provider: ${provider}\nCurrent model: ${modelId}\nCurrent thinking: ${thinkingLevel ?? "unknown"}\nRuntime status: ${runtimeStatus}`;
}

function formatScope(config: ResolvedFastModeConfig): string {
  return `Providers: ${config.providers.join(", ")}\nModels: ${config.models.join(", ")}\nThinking levels: any`;
}

export default function (pi: ExtensionAPI) {
  prependProjectBinToPath();

  pi.on("session_start", (_event, ctx) => {
    setStatus(ctx, loadConfig());
  });

  pi.on("model_select", (_event, ctx) => {
    setStatus(ctx, loadConfig());
  });

  pi.on("thinking_level_select", (_event, ctx) => {
    setStatus(ctx, loadConfig());
  });

  pi.registerCommand("fast-mode", {
    description: "Toggle OpenAI priority service tier: /fast-mode [on|off|status]",
    handler: (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";

      if (action === "on" || action === "enable") {
        const config = saveConfig(true);
        const thinkingLevel = pi.getThinkingLevel();
        setStatus(ctx, config);
        ctx.ui.notify(
          `Fast mode enabled (${config.serviceTier}).\n${formatScope(config)}\n${formatRuntime(config, ctx, thinkingLevel)}`,
          "info",
        );
        return Promise.resolve();
      }

      if (action === "off" || action === "disable") {
        const config = saveConfig(false);
        setStatus(ctx, config);
        ctx.ui.notify("Fast mode disabled.", "info");
        return Promise.resolve();
      }

      if (action === "status") {
        const config = loadConfig();
        const thinkingLevel = pi.getThinkingLevel();
        setStatus(ctx, config);
        ctx.ui.notify(
          `Fast mode is ${config.enabled ? "enabled" : "disabled"}.\nService tier: ${config.serviceTier}\n${formatScope(config)}\n${formatRuntime(config, ctx, thinkingLevel)}`,
          "info",
        );
        return Promise.resolve();
      }

      ctx.ui.notify("Usage: /fast-mode [on|off|status]", "warning");
      return Promise.resolve();
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!isProviderPayload(event.payload)) return undefined;

    const config = loadConfig();
    setStatus(ctx, config);
    if (!shouldUseFastMode(event.payload, config, ctx.model)) return undefined;
    if (event.payload.service_tier !== undefined) return undefined;

    return {
      ...event.payload,
      service_tier: config.serviceTier,
    };
  });
}
