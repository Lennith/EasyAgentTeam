import type { TaskActionRequest, TaskDetail, TaskPatchRequest, TaskTreeNode, TaskTreeResponse } from "@/types/project";
import { API_BASE, fetchJSON } from "./shared/http";
import { normalizeTaskDetail, normalizeTaskTreeNode, normalizeTaskTreeResponse } from "./project-mappers";

export const projectTaskApi = {
  getTaskTree: (
    projectId: string,
    options?: {
      focus_task_id?: string;
      max_descendant_depth?: number;
      include_external_dependencies?: boolean;
    }
  ) => {
    const params = new URLSearchParams();
    if (options?.focus_task_id) params.set("focus_task_id", options.focus_task_id);
    if (options?.max_descendant_depth) params.set("max_descendant_depth", String(options.max_descendant_depth));
    if (options?.include_external_dependencies !== undefined) {
      params.set("include_external_dependencies", String(options.include_external_dependencies));
    }
    const query = params.toString();
    const url = `${API_BASE}/projects/${encodeURIComponent(projectId)}/task-tree${query ? `?${query}` : ""}`;
    return fetchJSON<TaskTreeResponse>(url).then(normalizeTaskTreeResponse);
  },

  getTaskDetail: (projectId: string, taskId: string) =>
    fetchJSON<TaskDetail>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/detail`
    ).then(normalizeTaskDetail),

  taskAction: (projectId: string, data: TaskActionRequest) =>
    fetchJSON<{ taskId?: string; success: boolean }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/task-actions`,
      {
        method: "POST",
        body: JSON.stringify(data)
      }
    ),

  patchTask: (projectId: string, taskId: string, data: TaskPatchRequest) =>
    fetchJSON<{ success: boolean; task: TaskTreeNode }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(data)
      }
    ).then((payload) => ({
      ...payload,
      task: normalizeTaskTreeNode(payload.task)
    }))
};
