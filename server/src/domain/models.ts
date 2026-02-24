export type TaskState =
  | "PLANNED"
  | "READY"
  | "DISPATCHED"
  | "IN_PROGRESS"
  | "BLOCKED_DEP"
  | "MAY_BE_DONE"
  | "DONE"
  | "CANCELED";

export type TaskKind = "PROJECT_ROOT" | "USER_ROOT" | "EXECUTION";
export type ReminderMode = "backoff" | "fixed_interval";
export type RoleRuntimeState = "INACTIVE" | "IDLE" | "RUNNING";

export interface ProjectRecord {
  schemaVersion: "1.0";
  projectId: string;
  name: string;
  workspacePath: string;
  templateId?: string;
  agentIds?: string[];
  routeTable?: Record<string, string[]>;
  taskAssignRouteTable?: Record<string, string[]>;
  routeDiscussRounds?: Record<string, Record<string, number>>;
  agentModelConfigs?: Record<string, { tool: "codex" | "trae" | "minimax"; model: string; effort?: "low" | "medium" | "high" }>;
  autoDispatchEnabled?: boolean;
  autoDispatchRemaining?: number;
  autoReminderEnabled?: boolean;
  reminderMode?: ReminderMode;
  createdAt: string;
  updatedAt: string;
  roleSessionMap?: Record<string, string>;
  roleMessageStatus?: Record<string, RoleMessageStatus>;
}

export interface RoleMessageStatus {
  confirmedMessageIds: string[];
  pendingConfirmedMessages: PendingConfirmedMessage[];
  lastDispatchedAt?: string;
}

export interface ProjectSummary {
  projectId: string;
  name: string;
  workspacePath: string;
  dataPath: string;
}

export interface TaskRecord {
  taskId: string;
  taskKind: TaskKind;
  parentTaskId: string;
  rootTaskId: string;
  title: string;
  creatorRole?: string;
  creatorSessionId?: string;
  ownerRole: string;
  ownerSession?: string;
  state: TaskState;
  priority?: number;
  writeSet: string[];
  dependencies: string[];
  acceptance: string[];
  artifacts: string[];
  alert?: string;
  grantedAt?: string;
  closedAt?: string;
  closeReportId?: string;
  createdAt: string;
  updatedAt: string;
  lastSummary?: string;
}

export interface TaskboardState {
  schemaVersion: "1.0";
  projectId: string;
  updatedAt: string;
  tasks: TaskRecord[];
}

export interface ProjectPaths {
  projectRootDir: string;
  projectConfigFile: string;
  collabDir: string;
  eventsFile: string;
  taskboardFile: string;
  sessionsFile: string;
  roleRemindersFile: string;
  locksDir: string;
  inboxDir: string;
  outboxDir: string;
  auditDir: string;
  agentOutputFile: string;
  promptsDir: string;
}

export type SessionStatus = "running" | "idle" | "blocked" | "dismissed";

export interface PendingConfirmedMessage {
  messageId: string;
  dispatchedAt: string;
}

export interface SessionRecord {
  schemaVersion: "1.0";
  sessionId: string;
  projectId: string;
  role: string;
  provider: "codex" | "trae" | "minimax";
  providerSessionId?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  currentTaskId?: string;
  lastInboxMessageId?: string;
  lastDispatchedAt?: string;
  agentPid?: number;
  pendingConfirmedMessages?: PendingConfirmedMessage[];
  confirmedMessageIds?: string[];
  idleSince?: string;
  reminderCount?: number;
  nextReminderAt?: string;
  timeoutStreak?: number;
  errorStreak?: number;
  lastFailureAt?: string;
  lastFailureKind?: "timeout" | "error";
  lastRunId?: string;
  lastDispatchId?: string;
  cooldownUntil?: string;
}

export interface SessionsState {
  schemaVersion: "1.0";
  projectId: string;
  updatedAt: string;
  sessions: SessionRecord[];
}

export interface RoleReminderState {
  role: string;
  idleSince?: string;
  reminderCount: number;
  nextReminderAt?: string;
  lastRoleState?: RoleRuntimeState;
}

export interface RoleRemindersState {
  schemaVersion: "1.0";
  projectId: string;
  updatedAt: string;
  roleReminders: RoleReminderState[];
}

export interface AgentDefinition {
  schemaVersion: "1.0";
  agentId: string;
  displayName: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  defaultCliTool?: "codex" | "trae" | "minimax";
  defaultModelParams?: Record<string, any>;
  modelSelectionEnabled?: boolean;
}

export interface AgentRegistryState {
  schemaVersion: "1.0";
  updatedAt: string;
  agents: AgentDefinition[];
}

export interface AgentTemplateDefinition {
  schemaVersion: "1.0";
  templateId: string;
  displayName: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  basedOnTemplateId?: string;
}

export interface AgentTemplateRegistryState {
  schemaVersion: "1.0";
  updatedAt: string;
  templates: AgentTemplateDefinition[];
}

export interface NextActionInput {
  targetSessionId?: string;
  toRole?: string;
  toAgentId?: string;
  taskId?: string;
  title?: string;
  writeSet?: string[];
  dependencies?: string[];
  acceptance?: string[];
  artifacts?: string[];
  type?: string;
  payload?: Record<string, unknown>;
}

export interface ManagerRequestInput {
  type: string;
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
}

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

export interface TaskReportResult {
  taskId: string;
  outcome: "IN_PROGRESS" | "BLOCKED_DEP" | "DONE" | "CANCELED";
  summary?: string;
  artifacts?: string[];
  blockers?: string[];
}

export interface TaskReport {
  schemaVersion: "1.0";
  reportId: string;
  projectId: string;
  sessionId: string;
  agentId: string;
  parentTaskId?: string;
  summary: string;
  createdAt: string;
  results: TaskReportResult[];
  correlation: {
    request_id: string;
    parent_request_id?: string;
    task_id?: string;
  };
}

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
  expect: "TASK_REPORT" | "DELIVERABLE_READY" | "DISCUSS_REPLY";
  deadline?: string;
}

export interface Envelope {
  message_id: string;
  project_id: string;
  timestamp: string;
  sender: SenderInfo;
  via: ViaInfo;
  intent: "TASK_ASSIGNMENT" | "TASK_DISCUSS" | "TASK_REPORT" | "SYSTEM_NOTICE" | "DELIVERABLE_REQUEST" | string;
  priority: "low" | "normal" | "high" | "urgent";
  correlation: CorrelationInfo;
  accountability?: AccountabilityInfo;
  dispatch_policy?: "auto_latest_session" | "fixed_session" | "broadcast";
}

export interface ManagerToAgentMessage {
  envelope: Envelope;
  body: Record<string, unknown>;
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

export interface TeamAgentRequest {
  requestId: string;
  projectId: string;
  fromAgent: string;
  fromSessionId: string;
  agentId: string;
  displayName: string;
  prompt: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  updatedAt: string;
}

export type TaskActionType =
  | "TASK_CREATE"
  | "TASK_UPDATE"
  | "TASK_ASSIGN"
  | "TASK_DISCUSS_REQUEST"
  | "TASK_DISCUSS_REPLY"
  | "TASK_DISCUSS_CLOSED"
  | "TASK_REPORT";

export interface TaskActionRequest {
  actionType: TaskActionType;
  fromAgent?: string;
  fromSessionId?: string;
  toRole?: string;
  toSessionId?: string;
  taskId?: string;
  parentTaskId?: string;
  payload: Record<string, unknown>;
}

export interface TaskActionResult {
  success: boolean;
  requestId: string;
  actionType: TaskActionType;
  taskId?: string;
  messageId?: string;
  errorCode?: string;
  partialApplied?: boolean;
  appliedTaskIds?: string[];
  rejectedResults?: Array<{
    task_id: string;
    reason_code: string;
    reason: string;
  }>;
}

export interface TaskTreeNode {
  task_id: string;
  task_detail_id: string;
  task_kind: TaskKind;
  parent_task_id: string;
  root_task_id: string;
  title: string;
  state: TaskState;
  creator_role: string | null;
  creator_session_id: string | null;
  owner_role: string;
  owner_session: string | null;
  priority: number;
  dependencies: string[];
  write_set: string[];
  acceptance: string[];
  artifacts: string[];
  alert: string | null;
  granted_at: string | null;
  closed_at: string | null;
  close_report_id: string | null;
  created_at: string;
  updated_at: string;
  last_summary: string | null;
}

export interface TaskTreeEdge {
  edge_id: string;
  edge_type: "PARENT_CHILD" | "DEPENDS_ON";
  from_task_id: string;
  to_task_id: string;
  external: boolean;
}

export interface TaskTreeResponse {
  project_id: string;
  generated_at: string;
  query: {
    focus_task_id: string | null;
    max_descendant_depth: number | null;
    include_external_dependencies: boolean;
  };
  roots: string[];
  focus: {
    task_id: string | null;
    ancestor_ids: string[];
    descendant_ids: string[];
  };
  nodes: TaskTreeNode[];
  edges: TaskTreeEdge[];
  stats: {
    node_count: number;
    edge_count: number;
    external_dependency_edge_count: number;
  };
}

export interface TaskLifecycleEvent {
  event_id: string;
  event_type: string;
  source: EventSource;
  created_at: string;
  session_id: string | null;
  task_id: string | null;
  payload: Record<string, unknown>;
}

export interface TaskDetailResponse {
  project_id: string;
  task_id: string;
  task_detail_id: string;
  task: TaskTreeNode;
  created_by: {
    role: string | null;
    session_id: string | null;
  };
  create_parameters: Record<string, unknown> | null;
  lifecycle: TaskLifecycleEvent[];
  stats: {
    lifecycle_event_count: number;
  };
}

export interface RouteChangeRequest {
  requestId: string;
  projectId: string;
  fromAgent: string;
  fromSessionId: string;
  routeTable: Record<string, string[]>;
  agentIds?: string[];
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  updatedAt: string;
}

export interface AgentPreview {
  agentId: string;
  displayName: string;
  prompt: string;
  source: "requested" | "registered";
}

export interface RoutePreview {
  fromAgent: string;
  toAgents: string[];
  source: "requested" | "current";
}
