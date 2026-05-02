export interface EventRecord {
  eventId: string;
  eventType: string;
  source: string;
  createdAt: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

export interface AgentIOTimelineItem {
  id: string;
  projectId: string;
  sessionId: string;
  role: string;
  taskId?: string;
  direction: "inbound" | "outbound";
  messageType: string;
  summary?: string;
  createdAt: string;
  from?: string;
  toRole?: string;
  sourceType?: "user" | "agent" | "manager" | "system";
  originAgent?: string;
  kind?: string;
  status?: string;
  runId?: string;
}
