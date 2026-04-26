import {
  getRuntimeSettings,
  patchRuntimeSettings,
  type MCPServerConfig
} from "../data/repository/system/runtime-settings-repository.js";
import { getRuntimePlatformCapabilities } from "../runtime-platform.js";

export interface PatchRuntimeSettingsApiInput {
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
  providers?: PatchRuntimeSettingsApiProviders;
}

export interface PatchRuntimeSettingsApiProviders {
  codex?: {
    cliCommand?: string;
    model?: string;
    reasoningEffort?: "low" | "medium" | "high";
  };
  minimax?: {
    apiKey?: string | null;
    apiBase?: string | null;
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
  };
}

export interface RuntimeSettingsApiResponse {
  codexCliCommand: string;
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
  macosUntested: boolean;
  updatedAt: string;
  providers: {
    codex: {
      cliCommand?: string;
      model?: string;
      reasoningEffort?: "low" | "medium" | "high";
    };
    minimax: {
      apiKey?: string;
      apiBase?: string;
      model?: string;
      sessionDir?: string;
      mcpServers: unknown[];
      maxSteps: number;
      tokenLimit: number;
      maxOutputTokens: number;
      shellTimeout?: number;
      shellOutputIdleTimeout?: number;
      shellMaxRunTime?: number;
      shellMaxOutputSize?: number;
    };
  };
}

function toRuntimeSettingsApiResponse(
  settings: Awaited<ReturnType<typeof getRuntimeSettings>>
): RuntimeSettingsApiResponse {
  const runtime = getRuntimePlatformCapabilities();
  return {
    codexCliCommand: settings.codexCliCommand,
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
    macosUntested: runtime.macosUntested,
    updatedAt: settings.updatedAt,
    providers: {
      codex: {
        cliCommand: settings.providers.codex.cliCommand,
        model: settings.providers.codex.model,
        reasoningEffort: settings.providers.codex.reasoningEffort
      },
      minimax: {
        apiKey: settings.providers.minimax.apiKey,
        apiBase: settings.providers.minimax.apiBase,
        model: settings.providers.minimax.model,
        sessionDir: settings.providers.minimax.sessionDir,
        mcpServers: settings.providers.minimax.mcpServers ?? [],
        maxSteps: settings.providers.minimax.maxSteps ?? 0,
        tokenLimit: settings.providers.minimax.tokenLimit ?? 0,
        maxOutputTokens: settings.providers.minimax.maxOutputTokens ?? 0,
        shellTimeout: settings.providers.minimax.shellTimeout,
        shellOutputIdleTimeout: settings.providers.minimax.shellOutputIdleTimeout,
        shellMaxRunTime: settings.providers.minimax.shellMaxRunTime,
        shellMaxOutputSize: settings.providers.minimax.shellMaxOutputSize
      }
    }
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
