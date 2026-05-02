import type { ProviderId } from "@autodev/agent-library";

export interface WorkflowSessionRecord {
  schemaVersion: "1.0";
  sessionId: string;
  runId: string;
  role: string;
  provider: ProviderId;
  providerSessionId?: string | null;
  status: "running" | "idle" | "blocked" | "dismissed";
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  currentTaskId?: string;
  lastInboxMessageId?: string;
  lastDispatchedAt?: string;
  lastDispatchId?: string;
  lastDispatchedMessageId?: string;
}
