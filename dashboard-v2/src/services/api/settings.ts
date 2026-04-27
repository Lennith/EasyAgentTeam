import type { ModelInfo, RuntimeSettings } from "@/types";
import { API_BASE, fetchJSON } from "./shared/http";

export const settingsApi = {
  get: () => fetchJSON<RuntimeSettings>(`${API_BASE}/settings`),

  update: (
    data: Omit<Partial<RuntimeSettings>, "minimaxApiKey" | "minimaxApiBase"> & {
      minimaxApiKey?: string | null;
      minimaxApiBase?: string | null;
    }
  ) =>
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
