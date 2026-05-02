import type { RuntimeRecoveryAttemptsResponse, RuntimeRecoveryItem, RuntimeRecoveryResponse } from "@/types/recovery";
import { API_BASE, RECOVERY_CENTER_ATTEMPT_LIMIT, fetchJSON } from "./shared/http";
import {
  buildRetryDispatchGuardBody,
  mapRuntimeRecoveryAttemptsResponse,
  mapRuntimeRecoveryResponse
} from "./recovery-mappers";
import { mapWorkflowSessionFields } from "./workflow-mappers";

export const workflowSessionApi = {
  getSessions: (runId: string) =>
    fetchJSON<{ run_id: string; items: Record<string, unknown>[] }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions`
    ).then((payload) => ({
      run_id: payload.run_id,
      items: (payload.items ?? []).map(mapWorkflowSessionFields)
    })),

  getRuntimeRecovery: async (runId: string): Promise<RuntimeRecoveryResponse> =>
    mapRuntimeRecoveryResponse(
      await fetchJSON<Record<string, unknown>>(
        `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/runtime-recovery?attempt_limit=${RECOVERY_CENTER_ATTEMPT_LIMIT}`
      )
    ),

  getSessionRecoveryAttempts: async (
    runId: string,
    sessionId: string,
    attemptLimit: number | "all" = "all"
  ): Promise<RuntimeRecoveryAttemptsResponse> =>
    mapRuntimeRecoveryAttemptsResponse(
      await fetchJSON<Record<string, unknown>>(
        `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(sessionId)}/recovery-attempts?attempt_limit=${encodeURIComponent(String(attemptLimit))}`
      )
    ),

  registerSession: (
    runId: string,
    data: {
      role: string;
      session_id?: string;
      status?: "running" | "idle" | "blocked" | "dismissed";
      provider_id?: "codex" | "minimax" | "dpagent";
      provider?: "codex" | "minimax" | "dpagent";
      provider_session_id?: string;
    }
  ) =>
    fetchJSON<{ session: Record<string, unknown>; created: boolean }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions`,
      {
        method: "POST",
        body: JSON.stringify(data)
      }
    ).then((payload) => ({
      session: mapWorkflowSessionFields(payload.session),
      created: payload.created
    })),

  dismissSession: (runId: string, sessionId: string, reason?: string, confirm?: boolean) =>
    fetchJSON<{
      action: "dismiss";
      session: Record<string, unknown>;
      previous_status: string;
      next_status: string;
      provider_cancel: Record<string, unknown>;
      process_termination: Record<string, unknown> | null;
      mapping_cleared: boolean;
      warnings: string[];
    }>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(sessionId)}/dismiss`, {
      method: "POST",
      body: JSON.stringify({
        reason: reason ?? "dashboard_manual_dismiss",
        actor: "dashboard",
        ...(confirm ? { confirm: true } : {})
      })
    }).then((payload) => ({
      ...payload,
      session: mapWorkflowSessionFields(payload.session)
    })),

  repairSession: (runId: string, sessionId: string, targetStatus: "idle" | "blocked", confirm?: boolean) =>
    fetchJSON<{
      action: "repair";
      session: Record<string, unknown>;
      previous_status: string;
      next_status: string;
      warnings: string[];
    }>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(sessionId)}/repair`, {
      method: "POST",
      body: JSON.stringify({
        target_status: targetStatus,
        reason: "dashboard_manual_repair",
        actor: "dashboard",
        ...(confirm ? { confirm: true } : {})
      })
    }).then((payload) => ({
      ...payload,
      session: mapWorkflowSessionFields(payload.session)
    })),

  retryDispatchSession: (runId: string, item: RuntimeRecoveryItem, confirm?: boolean) =>
    fetchJSON<Record<string, unknown>>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(item.session_id)}/retry-dispatch`,
      {
        method: "POST",
        body: JSON.stringify(buildRetryDispatchGuardBody(item, "dashboard_manual_retry_dispatch", confirm))
      }
    )
};
