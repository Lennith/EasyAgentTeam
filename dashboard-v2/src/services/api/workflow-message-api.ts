import type { AgentIOTimelineItem } from "@/types/project";
import { API_BASE, fetchJSON } from "./shared/http";
import { mapWorkflowAgentIOTimelineItem } from "./workflow-mappers";

export const workflowMessageApi = {
  sendMessage: (
    runId: string,
    data: {
      from_agent?: string;
      from_session_id?: string;
      to?: { agent?: string; role?: string; session_id?: string };
      to_role?: string;
      to_session_id?: string;
      message_type?: "MANAGER_MESSAGE" | "TASK_DISCUSS_REQUEST" | "TASK_DISCUSS_REPLY" | "TASK_DISCUSS_CLOSED";
      task_id?: string;
      content: string;
      request_id?: string;
      parent_request_id?: string;
      discuss?: { thread_id?: string; request_id?: string };
    }
  ) =>
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
