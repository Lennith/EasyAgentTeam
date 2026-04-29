import type { CreateProjectRequest, ProjectDetail, ProjectSummary } from "@/types/project";
import { API_BASE, fetchJSON } from "./shared/http";

export const projectCoreApi = {
  list: () => fetchJSON<{ items: ProjectSummary[] }>(`${API_BASE}/projects`),

  get: (projectId: string) => fetchJSON<ProjectDetail>(`${API_BASE}/projects/${encodeURIComponent(projectId)}`),

  create: (data: CreateProjectRequest) =>
    fetchJSON<{ projectId: string }>(`${API_BASE}/projects`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  delete: (projectId: string) =>
    fetchJSON<{ success: boolean }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE"
    })
};
