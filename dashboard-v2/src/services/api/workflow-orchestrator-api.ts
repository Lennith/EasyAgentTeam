import type { WorkflowOrchestratorStatus, WorkflowRunMode, WorkflowRunOrchestratorSettings } from "@/types/workflow";
import { API_BASE, fetchJSON } from "./shared/http";

export const workflowOrchestratorApi = {
  getOrchestratorSettings: (runId: string) =>
    fetchJSON<WorkflowRunOrchestratorSettings>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/orchestrator/settings`
    ),

  patchOrchestratorSettings: (
    runId: string,
    data: {
      auto_dispatch_enabled?: boolean;
      auto_dispatch_remaining?: number;
      hold_enabled?: boolean;
      reminder_mode?: "backoff" | "fixed_interval";
      mode?: WorkflowRunMode;
      loop_enabled?: boolean;
      schedule_enabled?: boolean;
      schedule_expression?: string | null;
      is_schedule_seed?: boolean;
    }
  ) =>
    fetchJSON<WorkflowRunOrchestratorSettings>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/orchestrator/settings`,
      {
        method: "PATCH",
        body: JSON.stringify(data)
      }
    ),

  dispatch: (runId: string, data: { role?: string; task_id?: string; force?: boolean; only_idle?: boolean } = {}) =>
    fetchJSON<{
      runId: string;
      dispatchedCount: number;
      remainingBudget: number;
      results: Array<{
        role: string;
        sessionId: string | null;
        taskId: string | null;
        dispatchKind?: "task" | "message" | null;
        messageId?: string;
        requestId?: string;
        outcome: "dispatched" | "no_task" | "session_busy" | "run_not_running" | "invalid_target";
        reason?: string;
      }>;
    }>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/orchestrator/dispatch`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  getOrchestratorStatus: () => fetchJSON<WorkflowOrchestratorStatus>(`${API_BASE}/workflow-orchestrator/status`)
};
