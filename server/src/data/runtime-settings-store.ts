import path from "node:path";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { ensureDirectory, readJsonFile, writeJsonFile } from "./file-utils.js";
import { getRuntimePlatformCapabilities } from "../runtime-platform.js";

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

export interface RuntimeSettings {
  schemaVersion: "1.0";
  updatedAt: string;
  codexCliCommand: string;
  traeCliCommand: string;
  theme?: "dark" | "vibrant" | "lively";
  minimaxApiKey?: string;
  minimaxApiBase?: string;
  minimaxModel?: string;
  minimaxSessionDir?: string;
  minimaxMcpServers?: MCPServerConfig[];
  minimaxMaxSteps?: number;
  minimaxTokenLimit?: number;
  minimaxShellTimeout?: number;
  minimaxShellOutputIdleTimeout?: number;
  minimaxShellMaxRunTime?: number;
  minimaxShellMaxOutputSize?: number;
}

interface PatchRuntimeSettingsInput {
  codexCliCommand?: string;
  traeCliCommand?: string;
  theme?: "dark" | "vibrant" | "lively";
  minimaxApiKey?: string | null;
  minimaxApiBase?: string | null;
  minimaxModel?: string;
  minimaxSessionDir?: string;
  minimaxMcpServers?: MCPServerConfig[];
  minimaxMaxSteps?: number;
  minimaxTokenLimit?: number;
  minimaxShellTimeout?: number;
  minimaxShellOutputIdleTimeout?: number;
  minimaxShellMaxRunTime?: number;
  minimaxShellMaxOutputSize?: number;
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

function defaultTraeCliCommand(): string {
  return getRuntimePlatformCapabilities().traeCliCommandDefault;
}

function defaultRuntimeSettings(): RuntimeSettings {
  return {
    schemaVersion: "1.0",
    updatedAt: new Date().toISOString(),
    codexCliCommand: defaultCodexCliCommand(),
    traeCliCommand: defaultTraeCliCommand(),
    theme: "dark",
    minimaxApiKey: undefined,
    minimaxApiBase: undefined,
    minimaxModel: "MiniMax-M2.5-High-speed",
    minimaxSessionDir: undefined,
    minimaxMcpServers: [],
    minimaxMaxSteps: 100,
    minimaxTokenLimit: 80000
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

function normalizeTraeCliCommand(raw: unknown, fallback: string): string {
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

export async function getRuntimeSettings(dataRoot: string): Promise<RuntimeSettings> {
  const file = settingsPath(dataRoot);
  const fallback = defaultRuntimeSettings();
  const state = await readJsonFile<RuntimeSettings>(file, fallback);

  if (!(await exists(file))) {
    await ensureDirectory(path.dirname(file));
    await writeJsonFile(file, state);
  }

  return {
    schemaVersion: "1.0",
    updatedAt: state.updatedAt ?? fallback.updatedAt,
    codexCliCommand: normalizeCodexCliCommand(state.codexCliCommand, fallback.codexCliCommand),
    traeCliCommand: normalizeTraeCliCommand(state.traeCliCommand, fallback.traeCliCommand),
    minimaxApiKey: normalizeOptionalString(state.minimaxApiKey),
    minimaxApiBase: normalizeOptionalString(state.minimaxApiBase),
    minimaxModel: normalizeOptionalString(state.minimaxModel) ?? fallback.minimaxModel,
    minimaxSessionDir: normalizeOptionalString(state.minimaxSessionDir),
    minimaxMcpServers: normalizeMcpServers(state.minimaxMcpServers) ?? fallback.minimaxMcpServers,
    minimaxMaxSteps: normalizeOptionalNumber(state.minimaxMaxSteps) ?? fallback.minimaxMaxSteps,
    minimaxTokenLimit: normalizeOptionalNumber(state.minimaxTokenLimit) ?? fallback.minimaxTokenLimit,
    minimaxShellTimeout: normalizeOptionalNumber(state.minimaxShellTimeout),
    minimaxShellOutputIdleTimeout: normalizeOptionalNumber(state.minimaxShellOutputIdleTimeout),
    minimaxShellMaxRunTime: normalizeOptionalNumber(state.minimaxShellMaxRunTime),
    minimaxShellMaxOutputSize: normalizeOptionalNumber(state.minimaxShellMaxOutputSize)
  };
}

export async function patchRuntimeSettings(
  dataRoot: string,
  patch: PatchRuntimeSettingsInput
): Promise<RuntimeSettings> {
  const current = await getRuntimeSettings(dataRoot);
  const next: RuntimeSettings = {
    schemaVersion: "1.0",
    updatedAt: new Date().toISOString(),
    codexCliCommand: normalizeCodexCliCommand(
      patch.codexCliCommand ?? current.codexCliCommand,
      current.codexCliCommand
    ),
    traeCliCommand: normalizeTraeCliCommand(
      patch.traeCliCommand ?? current.traeCliCommand,
      current.traeCliCommand
    ),
    theme: normalizeTheme(patch.theme ?? current.theme) ?? "dark",
    minimaxApiKey: resolveOptionalStringPatch(patch, "minimaxApiKey", current.minimaxApiKey),
    minimaxApiBase: resolveOptionalStringPatch(patch, "minimaxApiBase", current.minimaxApiBase),
    minimaxModel: normalizeOptionalString(patch.minimaxModel ?? current.minimaxModel) ?? "MiniMax-M2.5-High-speed",
    minimaxSessionDir: normalizeOptionalString(patch.minimaxSessionDir ?? current.minimaxSessionDir),
    minimaxMcpServers: normalizeMcpServers(patch.minimaxMcpServers ?? current.minimaxMcpServers) ?? [],
    minimaxMaxSteps: normalizeOptionalNumber(patch.minimaxMaxSteps ?? current.minimaxMaxSteps) ?? 100,
    minimaxTokenLimit: normalizeOptionalNumber(patch.minimaxTokenLimit ?? current.minimaxTokenLimit) ?? 80000,
    minimaxShellTimeout: normalizeOptionalNumber(patch.minimaxShellTimeout ?? current.minimaxShellTimeout),
    minimaxShellOutputIdleTimeout: normalizeOptionalNumber(patch.minimaxShellOutputIdleTimeout ?? current.minimaxShellOutputIdleTimeout),
    minimaxShellMaxRunTime: normalizeOptionalNumber(patch.minimaxShellMaxRunTime ?? current.minimaxShellMaxRunTime),
    minimaxShellMaxOutputSize: normalizeOptionalNumber(patch.minimaxShellMaxOutputSize ?? current.minimaxShellMaxOutputSize)
  };
  await writeJsonFile(settingsPath(dataRoot), next);
  return next;
}
