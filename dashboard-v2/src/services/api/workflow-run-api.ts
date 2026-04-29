import type {
  WorkflowRunMode,
  WorkflowRunRecord,
  WorkflowRunRuntimeSnapshot,
  WorkflowRunRuntimeStatus,
  WorkflowTaskTreeRuntimeResponse
} from "@/types/workflow";
import { API_BASE, fetchJSON } from "./shared/http";
import {
  normalizeWorkflowRunRecord,
  normalizeWorkflowRunRuntimeSnapshot,
  normalizeWorkflowTaskTreeRuntimeResponse
} from "./workflow-mappers";

export const workflowRunApi = {
  listRuns: () =>
    fetchJSON<{ items: WorkflowRunRecord[]; total: number }>(`${API_BASE}/workflow-runs`).then((payload) => ({
      ...payload,
      items: (payload.items ?? []).map(normalizeWorkflowRunRecord)
    })),

  getRun: (runId: string) =>
    fetchJSON<WorkflowRunRecord>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}`).then(
      normalizeWorkflowRunRecord
    ),

  createRun: (data: {
    template_id: string;
    run_id?: string;
    name?: string;
    description?: string;
    workspace_path: string;
    variables?: Record<string, string>;
    task_overrides?: Record<string, string>;
    auto_start?: boolean;
    mode?: WorkflowRunMode;
    loop_enabled?: boolean;
    schedule_enabled?: boolean;
    schedule_expression?: string;
    is_schedule_seed?: boolean;
    auto_dispatch_enabled?: boolean;
    auto_dispatch_remaining?: number;
  }) =>
    fetchJSON<WorkflowRunRecord>(`${API_BASE}/workflow-runs`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  startRun: (runId: string) =>
    fetchJSON<{ runtime: WorkflowRunRuntimeStatus; run: WorkflowRunRecord | null }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/start`,
      { method: "POST" }
    ).then((payload) => ({
      ...payload,
      run: payload.run ? normalizeWorkflowRunRecord(payload.run) : payload.run
    })),

  stopRun: (runId: string) =>
    fetchJSON<{ runtime: WorkflowRunRuntimeStatus; run: WorkflowRunRecord | null }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/stop`,
      { method: "POST" }
    ).then((payload) => ({
      ...payload,
      run: payload.run ? normalizeWorkflowRunRecord(payload.run) : payload.run
    })),

  getRunStatus: (runId: string) =>
    fetchJSON<WorkflowRunRuntimeStatus>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/status`),

  getTaskRuntime: (runId: string) =>
    fetchJSON<WorkflowRunRuntimeSnapshot>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/task-runtime`).then(
      normalizeWorkflowRunRuntimeSnapshot
    ),

  getTaskTreeRuntime: (runId: string) =>
    fetchJSON<WorkflowTaskTreeRuntimeResponse>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/task-tree-runtime`
    ).then(normalizeWorkflowTaskTreeRuntimeResponse)
};
