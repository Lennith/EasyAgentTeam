import type { ProviderId } from "@autodev/agent-library";

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
  agentModelConfigs?: Record<string, { provider_id: ProviderId; model: string; effort?: "low" | "medium" | "high" }>;
  autoDispatchEnabled?: boolean;
  autoDispatchRemaining?: number;
  autoReminderEnabled?: boolean;
  holdEnabled?: boolean;
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
  provider: ProviderId;
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
  summary?: string;
  skillList?: string[];
  createdAt: string;
  updatedAt: string;
  defaultCliTool?: ProviderId;
  defaultModelParams?: Record<string, any>;
  modelSelectionEnabled?: boolean;
}

export interface AgentRegistryState {
  schemaVersion: "1.0";
  updatedAt: string;
  agents: AgentDefinition[];
}

export interface SkillDefinition {
  schemaVersion: "1.0";
  skillId: string;
  name: string;
  description: string;
  license: string;
  compatibility: string;
  sourceType: "opencode" | "codex" | "local";
  sourcePath: string;
  packagePath: string;
  entryFile: string;
  warnings?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillRegistryState {
  schemaVersion: "1.0";
  updatedAt: string;
  skills: SkillDefinition[];
}

export interface SkillListDefinition {
  schemaVersion: "1.0";
  listId: string;
  displayName: string;
  description?: string;
  includeAll: boolean;
  skillIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillListRegistryState {
  schemaVersion: "1.0";
  updatedAt: string;
  lists: SkillListDefinition[];
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

export interface ReminderTaskPayload {
  task_id: string;
  state?: string | null;
  task_kind?: string | null;
  parent_task_id?: string | null;
  root_task_id?: string | null;
  owner_role?: string | null;
  owner_session?: string | null;
  priority?: number | null;
  write_set?: string[];
  dependencies?: string[];
  acceptance?: string[];
  artifacts?: string[];
}

export interface ReminderOpenTaskTitleItem {
  task_id: string;
  title: string;
}

export interface ReminderPayload {
  role: string;
  reminder_mode: ReminderMode;
  reminder_count: number;
  open_task_ids: string[];
  open_task_titles: ReminderOpenTaskTitleItem[];
  next_reminder_at: string | null;
}

export interface ReminderMessageBody {
  [key: string]: unknown;
  mode: "CHAT";
  messageType: "MANAGER_MESSAGE";
  content: string;
  taskId: string | null;
  summary: string;
  task: ReminderTaskPayload | null;
  reminder: ReminderPayload;
  taskHint: string | null;
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
  workspaceRootAbs: string;
  resourceAbsPath: string;
  resourceType: "file" | "dir";
  ownerDomain: "project" | "workflow_run";
  ownerDomainId: string;
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

export interface WorkflowTemplateTaskRecord {
  taskId: string;
  title: string;
  ownerRole: string;
  parentTaskId?: string;
  dependencies?: string[];
  writeSet?: string[];
  acceptance?: string[];
  artifacts?: string[];
}

export interface WorkflowTemplateRecord {
  schemaVersion: "1.0";
  templateId: string;
  name: string;
  description?: string;
  tasks: WorkflowTemplateTaskRecord[];
  routeTable?: Record<string, string[]>;
  taskAssignRouteTable?: Record<string, string[]>;
  routeDiscussRounds?: Record<string, Record<string, number>>;
  defaultVariables?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowTemplateRegistryState {
  schemaVersion: "1.0";
  updatedAt: string;
  templates: WorkflowTemplateRecord[];
}

export type WorkflowRunState = "created" | "running" | "stopped" | "finished" | "failed";

export interface WorkflowRunTaskRecord extends WorkflowTemplateTaskRecord {
  resolvedTitle: string;
  creatorRole?: string;
  creatorSessionId?: string;
}

export type WorkflowTaskState = TaskState;

export type WorkflowTaskOutcome = "IN_PROGRESS" | "BLOCKED_DEP" | "MAY_BE_DONE" | "DONE" | "CANCELED";

export type WorkflowBlockReasonCode =
  | "DEP_UNSATISFIED"
  | "RUN_NOT_RUNNING"
  | "INVALID_TRANSITION"
  | "TASK_NOT_FOUND"
  | "TASK_ALREADY_TERMINAL";

export interface WorkflowTaskBlockReason {
  code: WorkflowBlockReasonCode;
  dependencyTaskIds?: string[];
  message?: string;
}

export interface WorkflowTaskTransitionRecord {
  seq: number;
  at: string;
  fromState: WorkflowTaskState | null;
  toState: WorkflowTaskState;
  reasonCode?: WorkflowBlockReasonCode;
  summary?: string;
}

export interface WorkflowTaskRuntimeRecord {
  taskId: string;
  state: WorkflowTaskState;
  blockedBy: string[];
  blockedReasons: WorkflowTaskBlockReason[];
  lastSummary?: string;
  blockers?: string[];
  lastTransitionAt: string;
  transitionCount: number;
  transitions: WorkflowTaskTransitionRecord[];
}

export interface WorkflowRunRuntimeState {
  initializedAt: string;
  updatedAt: string;
  transitionSeq: number;
  tasks: WorkflowTaskRuntimeRecord[];
}

export interface WorkflowRunRecord {
  schemaVersion: "2.0";
  runId: string;
  templateId: string;
  name: string;
  description?: string;
  workspacePath: string;
  routeTable?: Record<string, string[]>;
  taskAssignRouteTable?: Record<string, string[]>;
  routeDiscussRounds?: Record<string, Record<string, number>>;
  variables?: Record<string, string>;
  taskOverrides?: Record<string, string>;
  tasks: WorkflowRunTaskRecord[];
  status: WorkflowRunState;
  autoDispatchEnabled?: boolean;
  autoDispatchRemaining?: number;
  holdEnabled?: boolean;
  reminderMode?: ReminderMode;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stoppedAt?: string;
  lastHeartbeatAt?: string;
  runtime?: WorkflowRunRuntimeState;
}

export interface WorkflowRunRuntimeCounters {
  total: number;
  planned: number;
  ready: number;
  dispatched: number;
  mayBeDone: number;
  blocked: number;
  inProgress: number;
  done: number;
  canceled: number;
}

export interface WorkflowRunRuntimeSnapshot {
  runId: string;
  status: WorkflowRunState;
  active: boolean;
  updatedAt: string;
  counters: WorkflowRunRuntimeCounters;
  tasks: WorkflowTaskRuntimeRecord[];
}

export type WorkflowTaskActionType =
  | "TASK_CREATE"
  | "TASK_DISCUSS_REQUEST"
  | "TASK_DISCUSS_REPLY"
  | "TASK_DISCUSS_CLOSED"
  | "TASK_REPORT";

export interface WorkflowTaskActionRequest {
  actionType: WorkflowTaskActionType;
  fromAgent?: string;
  fromSessionId?: string;
  toRole?: string;
  toSessionId?: string;
  taskId?: string;
  content?: string;
  task?: {
    taskId: string;
    title: string;
    ownerRole: string;
    parentTaskId?: string;
    dependencies?: string[];
    acceptance?: string[];
    artifacts?: string[];
  };
  discuss?: {
    threadId?: string;
    requestId?: string;
  };
  results?: Array<{
    taskId: string;
    outcome: WorkflowTaskOutcome;
    summary?: string;
    blockers?: string[];
  }>;
}

export interface WorkflowTaskActionResult {
  success: boolean;
  requestId: string;
  actionType: WorkflowTaskActionType;
  createdTaskId?: string;
  messageId?: string;
  partialApplied: boolean;
  appliedTaskIds: string[];
  rejectedResults: Array<{
    taskId: string;
    reasonCode: WorkflowBlockReasonCode;
    reason: string;
  }>;
  snapshot: WorkflowRunRuntimeSnapshot;
}

export interface WorkflowRunRegistryState {
  schemaVersion: "2.0";
  updatedAt: string;
  runs: WorkflowRunRecord[];
}

export type WorkflowSessionStatus = "running" | "idle" | "blocked" | "dismissed";

export interface WorkflowSessionRecord {
  schemaVersion: "1.0";
  sessionId: string;
  runId: string;
  role: string;
  provider: ProviderId;
  providerSessionId?: string;
  status: WorkflowSessionStatus;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  currentTaskId?: string;
  lastInboxMessageId?: string;
  lastDispatchedAt?: string;
  lastDispatchId?: string;
  lastDispatchedMessageId?: string;
  timeoutStreak?: number;
  errorStreak?: number;
  lastFailureAt?: string;
  lastFailureKind?: "timeout" | "error";
  cooldownUntil?: string;
  lastRunId?: string;
  agentPid?: number;
}

export interface WorkflowSessionsState {
  schemaVersion: "1.0";
  runId: string;
  updatedAt: string;
  sessions: WorkflowSessionRecord[];
}

export interface WorkflowRoleReminderState {
  role: string;
  idleSince?: string;
  reminderCount: number;
  nextReminderAt?: string;
  lastRoleState?: RoleRuntimeState;
}

export interface WorkflowRoleRemindersState {
  schemaVersion: "1.0";
  runId: string;
  updatedAt: string;
  roleReminders: WorkflowRoleReminderState[];
}

export type WorkflowEventSource = "manager" | "agent" | "system" | "dashboard";

export interface WorkflowRunEventRecord {
  schemaVersion: "1.0";
  eventId: string;
  runId: string;
  eventType: string;
  source: WorkflowEventSource;
  createdAt: string;
  sessionId?: string;
  taskId?: string;
  payload: Record<string, unknown>;
}

export interface WorkflowTimelineItem {
  itemId: string;
  kind:
    | "user_message"
    | "message_routed"
    | "task_action"
    | "task_discuss"
    | "task_report"
    | "dispatch_started"
    | "dispatch_finished"
    | "dispatch_failed";
  createdAt: string;
  from?: string;
  toRole?: string | null;
  toSessionId?: string | null;
  requestId?: string | null;
  messageId?: string | null;
  runId?: string | null;
  status?: string | null;
  content?: string;
  messageType?: string | null;
  discussThreadId?: string | null;
  sourceType?: "user" | "agent" | "manager" | "system" | null;
  originAgent?: string | null;
  relaySource?: string | null;
  mergedFromBuffered?: boolean;
  mergedCount?: number | null;
  sourceRequestIds?: string[] | null;
}

export interface WorkflowEnvelope {
  message_id: string;
  run_id: string;
  timestamp: string;
  sender: SenderInfo;
  via: ViaInfo;
  intent: "TASK_ASSIGNMENT" | "TASK_DISCUSS" | "TASK_REPORT" | "SYSTEM_NOTICE" | "DELIVERABLE_REQUEST" | string;
  priority: "low" | "normal" | "high" | "urgent";
  correlation: CorrelationInfo;
  accountability?: AccountabilityInfo;
  dispatch_policy?: "auto_latest_session" | "fixed_session" | "broadcast";
}

export interface WorkflowManagerToAgentMessage {
  envelope: WorkflowEnvelope;
  body: Record<string, unknown>;
}
