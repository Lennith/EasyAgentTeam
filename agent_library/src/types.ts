export type ProviderId = "codex" | "minimax";

export interface ProviderCapabilities {
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsMultimodalInput: boolean;
  supportsMultimodalOutput: boolean;
  supportsSessionResume: boolean;
}

export interface ProviderConfigRef {
  providerId: ProviderId;
  model: string;
  effort?: "low" | "medium" | "high";
}

export type ContextPartType = "text" | "image" | "audio" | "file";

export interface ContextEnvelopePart {
  type: ContextPartType;
  text?: string;
  mimeType?: string;
  uri?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextEnvelope {
  contextId: string;
  sessionId: string;
  role: string;
  parts: ContextEnvelopePart[];
  metadata?: Record<string, unknown>;
}

export interface ToolCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  success: boolean;
  content: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export type ProviderResponseEventType =
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "message"
  | "step"
  | "error"
  | "complete";

export interface ProviderResponseEvent {
  event: ProviderResponseEventType;
  payload: Record<string, unknown>;
  at: string;
}

export interface ProviderRequest {
  requestId: string;
  provider: ProviderConfigRef;
  prompt: string;
  context: ContextEnvelope;
  maxSteps?: number;
  tokenLimit?: number;
}

export interface ProviderRunResult {
  providerSessionId?: string;
  events: ProviderResponseEvent[];
  finishReason?: string;
}

export type TaskActionType =
  | "TASK_CREATE"
  | "TASK_ASSIGN"
  | "TASK_UPDATE"
  | "TASK_REPORT"
  | "TASK_DISCUSS_REQUEST"
  | "TASK_DISCUSS_REPLY"
  | "TASK_DISCUSS_CLOSED";

export interface TaskActionResultItem {
  taskId: string;
  outcome: "IN_PROGRESS" | "BLOCKED_DEP" | "MAY_BE_DONE" | "DONE" | "CANCELED";
  summary?: string;
  blockers?: string[];
}

export interface TaskActionPayload {
  actionType: TaskActionType;
  fromAgent: string;
  fromSessionId: string;
  taskId?: string;
  toRole?: string;
  toSessionId?: string;
  content?: string;
  results?: TaskActionResultItem[];
  task?: Record<string, unknown>;
}

export interface EventRecord {
  schemaVersion: "1.0";
  eventId: string;
  projectId: string;
  eventType: string;
  source: "manager" | "agent" | "system" | "dashboard";
  createdAt: string;
  sessionId?: string;
  taskId?: string;
  payload: Record<string, unknown>;
}

export interface LockRecord {
  schemaVersion: "1.0";
  lockId: string;
  projectId: string;
  lockKey: string;
  ownerSessionId: string;
  targetType?: "file" | "dir";
  purpose?: string;
  ttlSeconds: number;
  acquiredAt: string;
  expiresAt: string;
  releasedAt?: string;
  renewCount: number;
  status: "active" | "released" | "expired";
}

export interface ManagerToAgentMessage {
  envelope: {
    message_id: string;
    project_id: string;
    timestamp: string;
    sender: { type: "agent" | "user" | "system"; role: string; session_id: string };
    via: { type: "manager" };
    intent: string;
    priority: "low" | "normal" | "high" | "urgent";
    correlation: { request_id: string; parent_request_id?: string; task_id?: string };
    dispatch_policy?: "auto_latest_session" | "fixed_session" | "broadcast";
  };
  body: Record<string, unknown>;
}
