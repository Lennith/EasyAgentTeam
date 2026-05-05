import type { AuthLoginResponse, AuthStatusResponse, RuntimeSettingsPatchPublicRequest } from "@autodev/agent-library";
import type { ModelInfo, RuntimeSettings } from "@/types/settings";
import { API_BASE, fetchJSON } from "./shared/http";

export type UpdateRuntimeSettingsRequest = RuntimeSettingsPatchPublicRequest;

export const settingsApi = {
  get: () => fetchJSON<RuntimeSettings>(`${API_BASE}/settings`),

  update: (data: UpdateRuntimeSettingsRequest) =>
    fetchJSON<RuntimeSettings>(`${API_BASE}/settings`, {
      method: "PATCH",
      body: JSON.stringify(data)
    })
};

export const authApi = {
  status: () => fetchJSON<AuthStatusResponse>(`${API_BASE}/auth/status`),

  login: (password: string) =>
    fetchJSON<AuthLoginResponse>(`${API_BASE}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ password })
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
