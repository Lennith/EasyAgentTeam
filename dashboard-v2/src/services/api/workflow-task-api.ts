import type { TaskDetail, TaskTreeResponse } from "@/types/project";
import type { WorkflowTaskActionRequest, WorkflowTaskActionResult } from "@/types/workflow";
import { API_BASE, fetchJSON } from "./shared/http";
import { normalizeTaskDetail, normalizeTaskTreeResponse } from "./project-mappers";
import { normalizeWorkflowRunRuntimeSnapshot } from "./workflow-mappers";

export const workflowTaskApi = {
  getTaskTree: (
    runId: string,
    query?: {
      focus_task_id?: string;
      max_descendant_depth?: number;
      include_external_dependencies?: boolean;
    }
  ) => {
    const params = new URLSearchParams();
    if (query?.focus_task_id) params.set("focus_task_id", query.focus_task_id);
    if (typeof query?.max_descendant_depth === "number") {
      params.set("max_descendant_depth", String(query.max_descendant_depth));
    }
    if (typeof query?.include_external_dependencies === "boolean") {
      params.set("include_external_dependencies", query.include_external_dependencies ? "true" : "false");
    }
    const suffix = params.toString();
    return fetchJSON<TaskTreeResponse>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/task-tree${suffix ? `?${suffix}` : ""}`
    ).then(normalizeTaskTreeResponse);
  },

  getTaskDetail: (runId: string, taskId: string) =>
    fetchJSON<TaskDetail>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/detail`
    ).then(normalizeTaskDetail),

  taskAction: (runId: string, data: WorkflowTaskActionRequest) =>
    fetchJSON<WorkflowTaskActionResult>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/task-actions`, {
      method: "POST",
      body: JSON.stringify(data)
    }).then((payload) => ({
      ...payload,
      snapshot: normalizeWorkflowRunRuntimeSnapshot(payload.snapshot)
    }))
};
