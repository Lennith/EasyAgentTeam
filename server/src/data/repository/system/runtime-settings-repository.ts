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
  codexCliCommand: string;
  theme?: "dark" | "vibrant" | "lively";
  minimaxApiKey?: string;
  minimaxApiBase?: string;
  minimaxModel?: string;
  minimaxSessionDir?: string;
  minimaxMcpServers?: MCPServerConfig[];
  minimaxMaxSteps?: number;
  minimaxTokenLimit?: number;
  minimaxMaxOutputTokens?: number;
  minimaxShellTimeout?: number;
  minimaxShellOutputIdleTimeout?: number;
  minimaxShellMaxRunTime?: number;
  minimaxShellMaxOutputSize?: number;
  providers: ProviderProfiles;
}

interface PatchRuntimeSettingsInput {
  codexCliCommand?: string;
  theme?: "dark" | "vibrant" | "lively";
  minimaxApiKey?: string | null;
  minimaxApiBase?: string | null;
  minimaxModel?: string;
  minimaxSessionDir?: string;
  minimaxMcpServers?: MCPServerConfig[];
  minimaxMaxSteps?: number;
  minimaxTokenLimit?: number;
  minimaxMaxOutputTokens?: number;
  minimaxShellTimeout?: number;
  minimaxShellOutputIdleTimeout?: number;
  minimaxShellMaxRunTime?: number;
  minimaxShellMaxOutputSize?: number;
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
    codexCliCommand,
    theme: "dark",
    minimaxApiKey: undefined,
    minimaxApiBase: undefined,
    minimaxModel,
    minimaxSessionDir: undefined,
    minimaxMcpServers: [],
    minimaxMaxSteps: 100,
    minimaxTokenLimit: 80000,
    minimaxMaxOutputTokens: 16384,
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

function hasOwnField<T extends object>(obj: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function resolveOptionalStringPatch<T extends object>(
  patch: T,
  key: keyof T,
  current: string | undefined
): string | undefined {
  if (!hasOwnField(patch, key)) {
    return current;
  }
  const raw = (patch as Record<string, unknown>)[String(key)];
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
    (rawCodex as CodexProviderProfile).cliCommand ?? state.codexCliCommand,
    fallback.codexCliCommand
  );
  const minimaxModel =
    normalizeOptionalString((rawMiniMax as MiniMaxProviderProfile).model) ??
    normalizeOptionalString(state.minimaxModel) ??
    fallback.minimaxModel;

  return {
    codex: {
      cliCommand: codexCliCommand,
      model: normalizeOptionalString((rawCodex as CodexProviderProfile).model),
      reasoningEffort: normalizeReasoningEffort((rawCodex as CodexProviderProfile).reasoningEffort)
    },
    minimax: {
      apiKey:
        normalizeOptionalString((rawMiniMax as MiniMaxProviderProfile).apiKey) ??
        normalizeOptionalString(state.minimaxApiKey),
      apiBase:
        normalizeOptionalString((rawMiniMax as MiniMaxProviderProfile).apiBase) ??
        normalizeOptionalString(state.minimaxApiBase),
      model: minimaxModel,
      sessionDir:
        normalizeOptionalString((rawMiniMax as MiniMaxProviderProfile).sessionDir) ??
        normalizeOptionalString(state.minimaxSessionDir),
      mcpServers:
        normalizeMcpServers((rawMiniMax as MiniMaxProviderProfile).mcpServers) ??
        normalizeMcpServers(state.minimaxMcpServers) ??
        fallback.minimaxMcpServers,
      maxSteps:
        normalizeOptionalNumber((rawMiniMax as MiniMaxProviderProfile).maxSteps) ??
        normalizeOptionalNumber(state.minimaxMaxSteps) ??
        fallback.minimaxMaxSteps,
      tokenLimit:
        normalizeOptionalNumber((rawMiniMax as MiniMaxProviderProfile).tokenLimit) ??
        normalizeOptionalNumber(state.minimaxTokenLimit) ??
        fallback.minimaxTokenLimit,
      maxOutputTokens:
        normalizeOptionalNumber((rawMiniMax as MiniMaxProviderProfile).maxOutputTokens) ??
        normalizeOptionalNumber(state.minimaxMaxOutputTokens) ??
        fallback.minimaxMaxOutputTokens,
      shellTimeout:
        normalizeOptionalNumber((rawMiniMax as MiniMaxProviderProfile).shellTimeout) ??
        normalizeOptionalNumber(state.minimaxShellTimeout),
      shellOutputIdleTimeout:
        normalizeOptionalNumber((rawMiniMax as MiniMaxProviderProfile).shellOutputIdleTimeout) ??
        normalizeOptionalNumber(state.minimaxShellOutputIdleTimeout),
      shellMaxRunTime:
        normalizeOptionalNumber((rawMiniMax as MiniMaxProviderProfile).shellMaxRunTime) ??
        normalizeOptionalNumber(state.minimaxShellMaxRunTime),
      shellMaxOutputSize:
        normalizeOptionalNumber((rawMiniMax as MiniMaxProviderProfile).shellMaxOutputSize) ??
        normalizeOptionalNumber(state.minimaxShellMaxOutputSize)
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
    codexCliCommand: providers.codex.cliCommand ?? fallback.codexCliCommand,
    minimaxApiKey: providers.minimax.apiKey,
    minimaxApiBase: providers.minimax.apiBase,
    minimaxModel: providers.minimax.model ?? fallback.minimaxModel,
    minimaxSessionDir: providers.minimax.sessionDir,
    minimaxMcpServers: providers.minimax.mcpServers ?? fallback.minimaxMcpServers,
    minimaxMaxSteps: providers.minimax.maxSteps ?? fallback.minimaxMaxSteps,
    minimaxTokenLimit: providers.minimax.tokenLimit ?? fallback.minimaxTokenLimit,
    minimaxMaxOutputTokens: providers.minimax.maxOutputTokens ?? fallback.minimaxMaxOutputTokens,
    minimaxShellTimeout: providers.minimax.shellTimeout,
    minimaxShellOutputIdleTimeout: providers.minimax.shellOutputIdleTimeout,
    minimaxShellMaxRunTime: providers.minimax.shellMaxRunTime,
    minimaxShellMaxOutputSize: providers.minimax.shellMaxOutputSize,
    providers
  };
}

export async function patchRuntimeSettings(
  dataRoot: string,
  patch: PatchRuntimeSettingsInput
): Promise<RuntimeSettings> {
  const current = await getRuntimeSettings(dataRoot);
  const providerPatch = patch.providers ?? {};
  const patchedCodexCliCommand = normalizeCodexCliCommand(
    providerPatch.codex?.cliCommand ?? patch.codexCliCommand ?? current.codexCliCommand,
    current.codexCliCommand
  );
  const patchedMiniMax: MiniMaxProviderProfile = {
    apiKey:
      providerPatch.minimax && hasOwnField(providerPatch.minimax, "apiKey")
        ? resolveOptionalStringPatch(providerPatch.minimax, "apiKey", current.minimaxApiKey)
        : resolveOptionalStringPatch(patch, "minimaxApiKey", current.minimaxApiKey),
    apiBase:
      providerPatch.minimax && hasOwnField(providerPatch.minimax, "apiBase")
        ? resolveOptionalStringPatch(providerPatch.minimax, "apiBase", current.minimaxApiBase)
        : resolveOptionalStringPatch(patch, "minimaxApiBase", current.minimaxApiBase),
    model: normalizeOptionalString(providerPatch.minimax?.model ?? patch.minimaxModel ?? current.minimaxModel) ?? "MiniMax-M2.5-High-speed",
    sessionDir: normalizeOptionalString(providerPatch.minimax?.sessionDir ?? patch.minimaxSessionDir ?? current.minimaxSessionDir),
    mcpServers: normalizeMcpServers(providerPatch.minimax?.mcpServers ?? patch.minimaxMcpServers ?? current.minimaxMcpServers) ?? [],
    maxSteps: normalizeOptionalNumber(providerPatch.minimax?.maxSteps ?? patch.minimaxMaxSteps ?? current.minimaxMaxSteps) ?? 100,
    tokenLimit: normalizeOptionalNumber(providerPatch.minimax?.tokenLimit ?? patch.minimaxTokenLimit ?? current.minimaxTokenLimit) ?? 80000,
    maxOutputTokens:
      normalizeOptionalNumber(providerPatch.minimax?.maxOutputTokens ?? patch.minimaxMaxOutputTokens ?? current.minimaxMaxOutputTokens) ?? 16384,
    shellTimeout: normalizeOptionalNumber(providerPatch.minimax?.shellTimeout ?? patch.minimaxShellTimeout ?? current.minimaxShellTimeout),
    shellOutputIdleTimeout: normalizeOptionalNumber(
      providerPatch.minimax?.shellOutputIdleTimeout ?? patch.minimaxShellOutputIdleTimeout ?? current.minimaxShellOutputIdleTimeout
    ),
    shellMaxRunTime: normalizeOptionalNumber(providerPatch.minimax?.shellMaxRunTime ?? patch.minimaxShellMaxRunTime ?? current.minimaxShellMaxRunTime),
    shellMaxOutputSize: normalizeOptionalNumber(
      providerPatch.minimax?.shellMaxOutputSize ?? patch.minimaxShellMaxOutputSize ?? current.minimaxShellMaxOutputSize
    )
  };
  const next: RuntimeSettings = {
    schemaVersion: "1.0",
    updatedAt: new Date().toISOString(),
    codexCliCommand: patchedCodexCliCommand,
    theme: normalizeTheme(patch.theme ?? current.theme) ?? "dark",
    minimaxApiKey: patchedMiniMax.apiKey,
    minimaxApiBase: patchedMiniMax.apiBase,
    minimaxModel: patchedMiniMax.model,
    minimaxSessionDir: patchedMiniMax.sessionDir,
    minimaxMcpServers: patchedMiniMax.mcpServers ?? [],
    minimaxMaxSteps: patchedMiniMax.maxSteps ?? 100,
    minimaxTokenLimit: patchedMiniMax.tokenLimit ?? 80000,
    minimaxMaxOutputTokens: patchedMiniMax.maxOutputTokens ?? 16384,
    minimaxShellTimeout: patchedMiniMax.shellTimeout,
    minimaxShellOutputIdleTimeout: patchedMiniMax.shellOutputIdleTimeout,
    minimaxShellMaxRunTime: patchedMiniMax.shellMaxRunTime,
    minimaxShellMaxOutputSize: patchedMiniMax.shellMaxOutputSize,
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
