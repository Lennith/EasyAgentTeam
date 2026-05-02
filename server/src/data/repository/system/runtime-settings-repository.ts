import path from "node:path";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { ensureDirectory } from "../../internal/persistence/file-utils.js";
import { readJsonFile, writeJsonFile } from "../../internal/persistence/store/store-runtime.js";
import { getRuntimePlatformCapabilities } from "../../../runtime-platform.js";

export interface MCPServerConfig {
  name: string;
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  connectTimeout?: number;
  executeTimeout?: number;
}

export interface CodexProviderProfile {
  cliCommand?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
}

export interface MiniMaxProviderProfile {
  apiKey?: string;
  apiBase?: string;
  model?: string;
  sessionDir?: string;
  mcpServers?: MCPServerConfig[];
  maxSteps?: number;
  tokenLimit?: number;
  maxOutputTokens?: number;
  shellTimeout?: number;
  shellOutputIdleTimeout?: number;
  shellMaxRunTime?: number;
  shellMaxOutputSize?: number;
}

export interface ProviderProfiles {
  codex: CodexProviderProfile;
  minimax: MiniMaxProviderProfile;
}

export interface RuntimeSettings {
  schemaVersion: "1.0";
  updatedAt: string;
  theme?: "dark" | "vibrant" | "lively";
  providers: ProviderProfiles;
}

interface PatchRuntimeSettingsInput {
  theme?: "dark" | "vibrant" | "lively";
  providers?: Partial<{
    codex: Partial<CodexProviderProfile>;
    minimax: Partial<Omit<MiniMaxProviderProfile, "apiKey" | "apiBase">> & {
      apiKey?: string | null;
      apiBase?: string | null;
    };
  }>;
}

function settingsPath(dataRoot: string): string {
  return path.join(dataRoot, "settings", "runtime.json");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    const stat: Stats = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function defaultCodexCliCommand(): string {
  return getRuntimePlatformCapabilities().codexCliCommandDefault;
}

function defaultRuntimeSettings(): RuntimeSettings {
  const codexCliCommand = defaultCodexCliCommand();
  const minimaxModel = "MiniMax-M2.5-High-speed";
  return {
    schemaVersion: "1.0",
    updatedAt: new Date().toISOString(),
    theme: "dark",
    providers: {
      codex: {
        cliCommand: codexCliCommand
      },
      minimax: {
        model: minimaxModel,
        mcpServers: [],
        maxSteps: 100,
        tokenLimit: 80000,
        maxOutputTokens: 16384
      }
    }
  };
}

export function getDefaultRuntimeSettings(): RuntimeSettings {
  return defaultRuntimeSettings();
}

function hasOwnField(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function resolveOptionalStringPatch(
  patch: object | undefined,
  key: string,
  current: string | undefined
): string | undefined {
  if (!patch || !hasOwnField(patch, key)) {
    return current;
  }
  const raw = (patch as Record<string, unknown>)[key];
  if (raw === null) {
    return undefined;
  }
  return normalizeOptionalString(raw);
}

function normalizeCodexCliCommand(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") {
    return fallback;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeOptionalString(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalNumber(raw: unknown): number | undefined {
  if (typeof raw !== "number") {
    return undefined;
  }
  return raw;
}

function normalizeMcpServers(raw: unknown): MCPServerConfig[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return raw as MCPServerConfig[];
}

function normalizeTheme(raw: unknown): "dark" | "vibrant" | "lively" | undefined {
  if (raw === "dark" || raw === "vibrant" || raw === "lively") {
    return raw;
  }
  return undefined;
}

function withoutUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as Partial<T>;
}

function normalizeReasoningEffort(raw: unknown): "low" | "medium" | "high" | undefined {
  if (raw === "low" || raw === "medium" || raw === "high") {
    return raw;
  }
  return undefined;
}

function normalizeProviderProfiles(state: Partial<RuntimeSettings>, fallback: RuntimeSettings): ProviderProfiles {
  const rawProviders = state.providers && typeof state.providers === "object" ? state.providers : {};
  const rawCodex = "codex" in rawProviders && rawProviders.codex ? rawProviders.codex : {};
  const rawMiniMax = "minimax" in rawProviders && rawProviders.minimax ? rawProviders.minimax : {};
  const codexCliCommand = normalizeCodexCliCommand(
    (rawCodex as CodexProviderProfile).cliCommand,
    fallback.providers.codex.cliCommand ?? defaultCodexCliCommand()
  );
  const minimaxModel =
    normalizeOptionalString((rawMiniMax as MiniMaxProviderProfile).model) ??
    fallback.providers.minimax.model ??
    "MiniMax-M2.5-High-speed";

  return {
    codex: {
      cliCommand: codexCliCommand,
      model: normalizeOptionalString((rawCodex as CodexProviderProfile).model),
      reasoningEffort: normalizeReasoningEffort((rawCodex as CodexProviderProfile).reasoningEffort)
    },
    minimax: {
      apiKey: normalizeOptionalString((rawMiniMax as MiniMaxProviderProfile).apiKey),
      apiBase: normalizeOptionalString((rawMiniMax as MiniMaxProviderProfile).apiBase),
      model: minimaxModel,
      sessionDir: normalizeOptionalString((rawMiniMax as MiniMaxProviderProfile).sessionDir),
      mcpServers:
        normalizeMcpServers((rawMiniMax as MiniMaxProviderProfile).mcpServers) ??
        fallback.providers.minimax.mcpServers,
      maxSteps:
        normalizeOptionalNumber((rawMiniMax as MiniMaxProviderProfile).maxSteps) ??
        fallback.providers.minimax.maxSteps,
      tokenLimit:
        normalizeOptionalNumber((rawMiniMax as MiniMaxProviderProfile).tokenLimit) ??
        fallback.providers.minimax.tokenLimit,
      maxOutputTokens:
        normalizeOptionalNumber((rawMiniMax as MiniMaxProviderProfile).maxOutputTokens) ??
        fallback.providers.minimax.maxOutputTokens,
      shellTimeout: normalizeOptionalNumber((rawMiniMax as MiniMaxProviderProfile).shellTimeout),
      shellOutputIdleTimeout: normalizeOptionalNumber((rawMiniMax as MiniMaxProviderProfile).shellOutputIdleTimeout),
      shellMaxRunTime: normalizeOptionalNumber((rawMiniMax as MiniMaxProviderProfile).shellMaxRunTime),
      shellMaxOutputSize: normalizeOptionalNumber((rawMiniMax as MiniMaxProviderProfile).shellMaxOutputSize)
    }
  };
}

export async function getRuntimeSettings(dataRoot: string): Promise<RuntimeSettings> {
  const file = settingsPath(dataRoot);
  const fallback = defaultRuntimeSettings();
  const state = await readJsonFile<RuntimeSettings>(file, fallback);

  if (!(await exists(file))) {
    await ensureDirectory(path.dirname(file));
    await writeJsonFile(file, state);
  }

  const providers = normalizeProviderProfiles(state, fallback);
  return {
    schemaVersion: "1.0",
    updatedAt: state.updatedAt ?? fallback.updatedAt,
    theme: normalizeTheme(state.theme) ?? fallback.theme,
    providers
  };
}

export async function patchRuntimeSettings(
  dataRoot: string,
  patch: PatchRuntimeSettingsInput
): Promise<RuntimeSettings> {
  const current = await getRuntimeSettings(dataRoot);
  const providerPatch = patch.providers ?? {};
  const patchedCodexCliCommand = normalizeCodexCliCommand(providerPatch.codex?.cliCommand, current.providers.codex.cliCommand ?? defaultCodexCliCommand());
  const patchedMiniMax: MiniMaxProviderProfile = {
    apiKey: resolveOptionalStringPatch(providerPatch.minimax, "apiKey", current.providers.minimax.apiKey),
    apiBase: resolveOptionalStringPatch(providerPatch.minimax, "apiBase", current.providers.minimax.apiBase),
    model: normalizeOptionalString(providerPatch.minimax?.model ?? current.providers.minimax.model) ?? "MiniMax-M2.5-High-speed",
    sessionDir: normalizeOptionalString(providerPatch.minimax?.sessionDir ?? current.providers.minimax.sessionDir),
    mcpServers: normalizeMcpServers(providerPatch.minimax?.mcpServers ?? current.providers.minimax.mcpServers) ?? [],
    maxSteps: normalizeOptionalNumber(providerPatch.minimax?.maxSteps ?? current.providers.minimax.maxSteps) ?? 100,
    tokenLimit: normalizeOptionalNumber(providerPatch.minimax?.tokenLimit ?? current.providers.minimax.tokenLimit) ?? 80000,
    maxOutputTokens: normalizeOptionalNumber(providerPatch.minimax?.maxOutputTokens ?? current.providers.minimax.maxOutputTokens) ?? 16384,
    shellTimeout: normalizeOptionalNumber(providerPatch.minimax?.shellTimeout ?? current.providers.minimax.shellTimeout),
    shellOutputIdleTimeout: normalizeOptionalNumber(
      providerPatch.minimax?.shellOutputIdleTimeout ?? current.providers.minimax.shellOutputIdleTimeout
    ),
    shellMaxRunTime: normalizeOptionalNumber(providerPatch.minimax?.shellMaxRunTime ?? current.providers.minimax.shellMaxRunTime),
    shellMaxOutputSize: normalizeOptionalNumber(providerPatch.minimax?.shellMaxOutputSize ?? current.providers.minimax.shellMaxOutputSize)
  };
  const next: RuntimeSettings = {
    schemaVersion: "1.0",
    updatedAt: new Date().toISOString(),
    theme: normalizeTheme(patch.theme ?? current.theme) ?? "dark",
    providers: {
      codex: {
        ...current.providers.codex,
        ...withoutUndefined(providerPatch.codex),
        cliCommand: patchedCodexCliCommand
      },
      minimax: patchedMiniMax
    }
  };
  await writeJsonFile(settingsPath(dataRoot), next);
  return next;
}
