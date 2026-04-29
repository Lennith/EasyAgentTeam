import type { DispatchResult, OrchestratorSettings } from "@/types/project";
import { API_BASE, fetchJSON } from "./shared/http";

export const projectOrchestratorApi = {
  dispatch: (
    projectId: string,
    data: { session_id?: string; force?: boolean; only_idle?: boolean; task_id?: string }
  ) =>
    fetchJSON<{ results: DispatchResult[] }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/orchestrator/dispatch`,
      {
        method: "POST",
        body: JSON.stringify(data)
      }
    ),

  dispatchMessage: (
    projectId: string,
    data: { message_id: string; session_id?: string; force?: boolean; only_idle?: boolean }
  ) =>
    fetchJSON<{ results: DispatchResult[] }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/orchestrator/dispatch-message`,
      {
        method: "POST",
        body: JSON.stringify(data)
      }
    ),

  getOrchestratorSettings: (projectId: string) =>
    fetchJSON<OrchestratorSettings>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/orchestrator/settings`),

  updateOrchestratorSettings: (
    projectId: string,
    data: {
      auto_dispatch_enabled?: boolean;
      auto_dispatch_remaining?: number;
      hold_enabled?: boolean;
      reminder_mode?: "backoff" | "fixed_interval";
    }
  ) =>
    fetchJSON<{
      project_id: string;
      auto_dispatch_enabled: boolean;
      auto_dispatch_remaining: number;
      hold_enabled: boolean;
      reminder_mode: "backoff" | "fixed_interval";
      updated_at: string;
    }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/orchestrator/settings`, {
      method: "PATCH",
      body: JSON.stringify(data)
    })
};
