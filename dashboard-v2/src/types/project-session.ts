export interface SessionRecord {
  sessionId: string;
  projectId: string;
  role: string;
  status: "running" | "idle" | "blocked" | "dismissed";
  createdAt: string;
  updatedAt: string;
  currentTaskId?: string;
  lastHeartbeat?: string;
  lastActiveAt?: string;
  lastDispatchedAt?: string;
  agentTool?: string;
  sessionKey?: string;
  providerSessionId?: string | null;
  provider?: string;
  locksHeldCount?: number;
}
