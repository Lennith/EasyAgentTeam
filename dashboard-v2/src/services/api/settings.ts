import type { MCPServerConfig, ModelInfo, RuntimeSettings, Theme } from "@/types/settings";
import { API_BASE, fetchJSON } from "./shared/http";

export interface UpdateRuntimeSettingsRequest {
  theme?: Theme;
  providers?: {
    codex?: {
      cliCommand?: string;
      model?: string;
      reasoningEffort?: "low" | "medium" | "high";
    };
    dpagent?: {
      cliCommand?: string;
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
  };
}

export const settingsApi = {
  get: () => fetchJSON<RuntimeSettings>(`${API_BASE}/settings`),

  update: (data: UpdateRuntimeSettingsRequest) =>
    fetchJSON<RuntimeSettings>(`${API_BASE}/settings`, {
      method: "PATCH",
      body: JSON.stringify(data)
    })
};

export const modelsApi = {
  list: (projectId?: string, refresh?: boolean) => {
    const params = new URLSearchParams();
    if (projectId) params.set("project_id", projectId);
    if (refresh) params.set("refresh", "true");
    return fetchJSON<{ models: ModelInfo[]; warnings?: string[]; source?: "cache" | "refresh" | "fallback-mixed" }>(
      `${API_BASE}/models?${params.toString()}`
    );
  }
};
