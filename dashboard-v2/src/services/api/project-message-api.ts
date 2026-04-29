import type { AgentIOTimelineItem, SendMessageRequest } from "@/types/project";
import { API_BASE, fetchJSON } from "./shared/http";
import { mapProjectAgentIOTimelineItem } from "./project-mappers";

export const projectMessageApi = {
  sendMessage: (projectId: string, data: SendMessageRequest) =>
    fetchJSON<{
      requestId: string;
      messageId: string;
      resolvedSessionId: string;
      messageType: string;
      buffered?: boolean;
    }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/messages/send`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  getAgentIOTimeline: async (projectId: string, limit?: number): Promise<{ items: AgentIOTimelineItem[] }> => {
    const url = limit
      ? `${API_BASE}/projects/${encodeURIComponent(projectId)}/agent-io/timeline?limit=${limit}`
      : `${API_BASE}/projects/${encodeURIComponent(projectId)}/agent-io/timeline`;
    try {
      const data = await fetchJSON<{ items: Record<string, unknown>[] }>(url);
      return { items: (data.items ?? []).map(mapProjectAgentIOTimelineItem) };
    } catch {
      return { items: [] };
    }
  }
};
