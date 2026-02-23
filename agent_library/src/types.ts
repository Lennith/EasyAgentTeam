export type FinalReportStatus =
  | "DONE"
  | "HANDOFF"
  | "BLOCKED"
  | "NEED_CLARIFICATION"
  | "FAILED";

export interface Artifact {
  kind: "image" | "doc" | "code" | "link" | string;
  path: string;
  note?: string;
}

export interface Problem {
  code: string;
  message: string;
  needed_from_manager: string[];
}

export interface SuggestedNextAction {
  to_role: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface FinalReport {
  schemaVersion: "1.0";
  reportId: string;
  projectId: string;
  sessionId: string;
  agentId: string;
  taskId?: string;
  status: FinalReportStatus;
  summary: string;
  details?: string;
  alert?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
  artifacts: Artifact[];
  correlation: {
    request_id: string;
    parent_request_id?: string;
    task_id?: string;
  };
  problems: Problem[];
  suggest_next_actions: SuggestedNextAction[];
  managerRequests?: Array<{
    type: "ACQUIRE_LOCKS" | "RENEW_LOCKS" | "RELEASE_LOCKS" | string;
    lockIds?: string[];
    lockKeys?: string[];
    relativePaths?: string[];
    ttlSeconds?: number;
    purpose?: string;
    locks?: Array<{
      lockKey: string;
      ttlSeconds?: number;
      purpose?: string;
    }>;
  }>;
}

export type ManagerMessageType =
  | "ASSIGN_TASK"
  | "CANCEL_TASK"
  | "REQUEST_UPDATE"
  | "SYSTEM_NOTICE";

export interface SenderInfo {
  type: "agent" | "user" | "system";
  role: string;
  session_id: string;
}

export interface ViaInfo {
  type: "manager";
}

export interface CorrelationInfo {
  request_id: string;
  parent_request_id?: string;
  task_id?: string;
}

export interface AccountabilityInfo {
  owner_role: string;
  report_to: {
    role: string;
    session_id?: string;
  };
  expect: "FINAL_REPORT" | "DELIVERABLE_READY" | "CLARIFICATION_ANSWER";
  deadline?: string;
}

export interface Envelope {
  message_id: string;
  project_id: string;
  timestamp: string;
  sender: SenderInfo;
  via: ViaInfo;
  intent: "TASK_ASSIGN" | "HANDOFF" | "CLARIFICATION" | "SYSTEM_NOTICE" | "DELIVERABLE_REQUEST" | string;
  priority: "low" | "normal" | "high" | "urgent";
  correlation: CorrelationInfo;
  accountability?: AccountabilityInfo;
  dispatch_policy?: "auto_latest_session" | "fixed_session" | "broadcast";
}

export interface ManagerToAgentMessage {
  envelope: Envelope;
  body: Record<string, unknown>;
}

export type LockStatus = "active" | "released" | "expired";

export interface LockRecord {
  schemaVersion: "1.0";
  lockId: string;
  projectId: string;
  lockKey: string;
  sanitizedKey: string;
  ownerSessionId: string;
  targetType?: "file" | "dir";
  purpose?: string;
  ttlSeconds: number;
  acquiredAt: string;
  expiresAt: string;
  releasedAt?: string;
  renewCount: number;
  status: LockStatus;
  stealReason?: string;
  stolenFromSessionId?: string;
}

export type EventSource = "manager" | "agent" | "system" | "dashboard";

export interface EventRecord {
  schemaVersion: "1.0";
  eventId: string;
  projectId: string;
  eventType: string;
  source: EventSource;
  createdAt: string;
  sessionId?: string;
  taskId?: string;
  payload: Record<string, unknown>;
}
