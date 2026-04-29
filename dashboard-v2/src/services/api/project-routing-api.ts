import type { ProjectDetail, RoutingConfigRequest } from "@/types/project";
import { API_BASE, fetchJSON } from "./shared/http";

export const projectRoutingApi = {
  updateRoutingConfig: (projectId: string, data: RoutingConfigRequest) =>
    fetchJSON<ProjectDetail>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/routing-config`, {
      method: "PATCH",
      body: JSON.stringify(data)
    }),

  getTaskAssignRouting: (projectId: string) =>
    fetchJSON<{ project_id: string; task_assign_route_table: Record<string, string[]>; updated_at: string }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/task-assign-routing`
    ),

  updateTaskAssignRouting: (projectId: string, taskAssignRouteTable: Record<string, string[]>) =>
    fetchJSON<{ project_id: string; task_assign_route_table: Record<string, string[]>; updated_at: string }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/task-assign-routing`,
      {
        method: "PATCH",
        body: JSON.stringify({ task_assign_route_table: taskAssignRouteTable })
      }
    )
};
