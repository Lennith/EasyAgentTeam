import type { OrchestratorStatus } from "@/types";
import { API_BASE, fetchJSON, fetchStream } from "./shared/http";

type AgentChatScope = { projectId: string; runId?: never } | { runId: string; projectId?: never };

interface AgentChatRequest {
  role: string;
  prompt: string;
  sessionId: string;
  providerSessionId?: string | null;
}

function buildAgentChatBasePath(scope: AgentChatScope): string {
  const projectId = (scope as { projectId?: string }).projectId;
  if (typeof projectId === "string") {
    return `${API_BASE}/projects/${encodeURIComponent(projectId)}/agent-chat`;
  }
  const runId = (scope as { runId?: string }).runId;
  if (typeof runId === "string") {
    return `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/agent-chat`;
  }
  throw new Error("Missing chat scope: projectId or runId is required");
}

export const agentChatApi = {
  stream: (scope: AgentChatScope, data: AgentChatRequest, signal?: AbortSignal) =>
    fetchStream(buildAgentChatBasePath(scope), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal
    }),

  interrupt: (scope: AgentChatScope, sessionId: string) =>
    fetchJSON<{ success: boolean; cancelled?: boolean }>(
      `${buildAgentChatBasePath(scope)}/${encodeURIComponent(sessionId)}/interrupt`,
      { method: "POST" }
    )
};

export const orchestratorApi = {
  getStatus: () => fetchJSON<OrchestratorStatus>(`${API_BASE}/orchestrator/status`)
};
