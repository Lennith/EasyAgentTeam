import type { RuntimeRecoveryAttemptsResponse, RuntimeRecoveryItem, RuntimeRecoveryResponse } from "@/types/recovery";
import type { SessionRecord } from "@/types/project";
import { API_BASE, RECOVERY_CENTER_ATTEMPT_LIMIT, fetchJSON } from "./shared/http";
import { mapSessionFields } from "./project-mappers";
import {
  buildRetryDispatchGuardBody,
  mapRuntimeRecoveryAttemptsResponse,
  mapRuntimeRecoveryResponse
} from "./recovery-mappers";

export const projectSessionApi = {
  getSessions: async (projectId: string): Promise<{ items: SessionRecord[] }> => {
    const data = await fetchJSON<{ items: Record<string, unknown>[] }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions`
    );
    return { items: (data.items ?? []).map(mapSessionFields) };
  },

  getRuntimeRecovery: async (projectId: string): Promise<RuntimeRecoveryResponse> =>
    mapRuntimeRecoveryResponse(
      await fetchJSON<Record<string, unknown>>(
        `${API_BASE}/projects/${encodeURIComponent(projectId)}/runtime-recovery?attempt_limit=${RECOVERY_CENTER_ATTEMPT_LIMIT}`
      )
    ),

  getSessionRecoveryAttempts: async (
    projectId: string,
    sessionId: string,
    attemptLimit: number | "all" = "all"
  ): Promise<RuntimeRecoveryAttemptsResponse> =>
    mapRuntimeRecoveryAttemptsResponse(
      await fetchJSON<Record<string, unknown>>(
        `${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/recovery-attempts?attempt_limit=${encodeURIComponent(String(attemptLimit))}`
      )
    ),

  dismissSession: (projectId: string, sessionId: string, reason?: string, confirm?: boolean) =>
    fetchJSON<Record<string, unknown>>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/dismiss`,
      {
        method: "POST",
        body: JSON.stringify({
          reason: reason ?? "dashboard_manual_dismiss",
          actor: "dashboard",
          ...(confirm ? { confirm: true } : {})
        })
      }
    ),

  repairSession: (projectId: string, sessionId: string, targetStatus: "idle" | "blocked", confirm?: boolean) =>
    fetchJSON<Record<string, unknown>>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/repair`,
      {
        method: "POST",
        body: JSON.stringify({
          target_status: targetStatus,
          reason: "dashboard_manual_repair",
          actor: "dashboard",
          ...(confirm ? { confirm: true } : {})
        })
      }
    ),

  retryDispatchSession: (projectId: string, item: RuntimeRecoveryItem, confirm?: boolean) =>
    fetchJSON<Record<string, unknown>>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(item.session_id)}/retry-dispatch`,
      {
        method: "POST",
        body: JSON.stringify(buildRetryDispatchGuardBody(item, "dashboard_manual_retry_dispatch", confirm))
      }
    ),

  registerSession: (projectId: string, data: { session_id: string; role: string; status?: string }) =>
    fetchJSON<{ success: boolean }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions`, {
      method: "POST",
      body: JSON.stringify(data)
    })
};
