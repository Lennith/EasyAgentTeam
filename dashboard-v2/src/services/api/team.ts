import type { CreateTeamRequest, TeamRecord, TeamSummary, UpdateTeamRequest } from "@/types";
import { API_BASE, fetchJSON } from "./shared/http";

export const teamApi = {
  list: () => fetchJSON<{ items: TeamSummary[] }>(`${API_BASE}/teams`),

  get: (teamId: string) => fetchJSON<TeamRecord>(`${API_BASE}/teams/${encodeURIComponent(teamId)}`),

  create: (data: CreateTeamRequest) =>
    fetchJSON<TeamRecord>(`${API_BASE}/teams`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  update: (teamId: string, data: UpdateTeamRequest) =>
    fetchJSON<TeamRecord>(`${API_BASE}/teams/${encodeURIComponent(teamId)}`, {
      method: "PUT",
      body: JSON.stringify(data)
    }),

  delete: (teamId: string) =>
    fetchJSON<{ removed: boolean }>(`${API_BASE}/teams/${encodeURIComponent(teamId)}`, {
      method: "DELETE"
    })
};
