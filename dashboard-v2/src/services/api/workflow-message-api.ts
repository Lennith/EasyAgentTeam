import type { AgentIOTimelineItem } from "@/types/project";
import type { WorkflowMessageSendPublicRequest } from "@autodev/agent-library";
import { API_BASE, fetchJSON } from "./shared/http";
import { mapWorkflowAgentIOTimelineItem } from "./workflow-mappers";

export const workflowMessageApi = {
  sendMessage: (runId: string, data: WorkflowMessageSendPublicRequest) =>
    fetchJSON<{
      requestId: string;
      messageId: string;
      messageType: string;
      taskId: string | null;
      toRole: string | null;
      resolvedSessionId: string;
      createdAt: string;
    }>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/messages/send`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  getTimeline: async (runId: string, limit = 300): Promise<{ items: AgentIOTimelineItem[]; total: number }> => {
    const data = await fetchJSON<{ items: Record<string, unknown>[]; total: number }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/agent-io/timeline?limit=${encodeURIComponent(String(limit))}`
    );
    return {
      total: data.total ?? 0,
      items: (data.items ?? []).map((raw) => mapWorkflowAgentIOTimelineItem(raw, runId))
    };
  },

  interruptAgentChat: (runId: string, sessionId: string) =>
    fetchJSON<{ success: boolean; cancelled: boolean }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/agent-chat/${encodeURIComponent(sessionId)}/interrupt`,
      { method: "POST" }
    )
};
