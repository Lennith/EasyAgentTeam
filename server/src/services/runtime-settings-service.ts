import {
  getRuntimeSettings,
  patchRuntimeSettings,
  type MCPServerConfig
} from "../data/repository/system/runtime-settings-repository.js";
import { getRuntimePlatformCapabilities } from "../runtime-platform.js";

export interface PatchRuntimeSettingsApiInput {
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
  minimaxMaxOutputTokens?: number;
  minimaxShellTimeout?: number;
  minimaxShellOutputIdleTimeout?: number;
  minimaxShellMaxRunTime?: number;
  minimaxShellMaxOutputSize?: number;
}

export interface RuntimeSettingsApiResponse {
  codexCliCommand: string;
  traeCliCommand: string;
  theme: string;
  minimaxApiKey?: string;
  minimaxApiBase?: string;
  minimaxModel: string;
  minimaxSessionDir?: string;
  minimaxMcpServers: unknown[];
  minimaxMaxSteps: number;
  minimaxTokenLimit: number;
  minimaxMaxOutputTokens: number;
  hostPlatform: string;
  hostPlatformLabel: string;
  supportedShellTypes: string[];
  defaultShellType: string;
  codexCliCommandDefault: string;
  traeCliCommandDefault: string;
  macosUntested: boolean;
  updatedAt: string;
}

function toRuntimeSettingsApiResponse(
  settings: Awaited<ReturnType<typeof getRuntimeSettings>>
): RuntimeSettingsApiResponse {
  const runtime = getRuntimePlatformCapabilities();
  return {
    codexCliCommand: settings.codexCliCommand,
    traeCliCommand: settings.traeCliCommand,
    theme: settings.theme ?? "dark",
    minimaxApiKey: settings.minimaxApiKey,
    minimaxApiBase: settings.minimaxApiBase,
    minimaxModel: settings.minimaxModel ?? "",
    minimaxSessionDir: settings.minimaxSessionDir,
    minimaxMcpServers: settings.minimaxMcpServers ?? [],
    minimaxMaxSteps: settings.minimaxMaxSteps ?? 0,
    minimaxTokenLimit: settings.minimaxTokenLimit ?? 0,
    minimaxMaxOutputTokens: settings.minimaxMaxOutputTokens ?? 0,
    hostPlatform: runtime.platform,
    hostPlatformLabel: runtime.label,
    supportedShellTypes: runtime.supportedShells,
    defaultShellType: runtime.defaultShell,
    codexCliCommandDefault: runtime.codexCliCommandDefault,
    traeCliCommandDefault: runtime.traeCliCommandDefault,
    macosUntested: runtime.macosUntested,
    updatedAt: settings.updatedAt
  };
}

export async function getRuntimeSettingsForApi(dataRoot: string): Promise<RuntimeSettingsApiResponse> {
  const settings = await getRuntimeSettings(dataRoot);
  return toRuntimeSettingsApiResponse(settings);
}

export async function readRuntimeSettings(dataRoot: string) {
  return getRuntimeSettings(dataRoot);
}

export async function patchRuntimeSettingsForApi(
  dataRoot: string,
  patch: PatchRuntimeSettingsApiInput
): Promise<RuntimeSettingsApiResponse> {
  const updated = await patchRuntimeSettings(dataRoot, patch);
  return toRuntimeSettingsApiResponse(updated);
}
