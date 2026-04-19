import type { ProviderId } from "@autodev/agent-library";

export interface ProjectSummary {
  projectId: string;
  name: string;
  workspacePath: string;
}

export interface ProjectDetail extends ProjectSummary {
  createdAt?: string;
  updatedAt?: string;
  templateId?: string;
  agentIds?: string[];
  routeTable?: Record<string, string[]>;
  taskAssignRouteTable?: Record<string, string[]>;
  routeDiscussRounds?: Record<string, Record<string, number>>;
  agentModelConfigs?: Record<string, AgentModelConfig>;
  autoDispatchEnabled?: boolean;
  autoDispatchRemaining?: number;
  holdEnabled?: boolean;
  roleSessionMap?: Record<string, string>;
}

export interface OrchestratorSettings {
  project_id: string;
  auto_dispatch_enabled: boolean;
  auto_dispatch_remaining: number;
  hold_enabled?: boolean;
  reminder_mode?: ReminderMode;
  updated_at: string;
}

export interface AgentModelConfig {
  provider_id: ProviderId;
  model: string;
  effort?: "low" | "medium" | "high";
}

export interface EventRecord {
  eventId: string;
  eventType: string;
  source: string;
  createdAt: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

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

export interface RuntimeRecoveryItem {
  role: string;
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  status: "running" | "idle" | "blocked" | "dismissed";
  current_task_id: string | null;
  current_task_title: string | null;
  current_task_state: string | null;
  cooldown_until: string | null;
  last_failure_at: string | null;
  last_failure_kind: "timeout" | "error" | null;
  error_streak: number;
  timeout_streak: number;
  retryable: boolean | null;
  code: string | null;
  message: string | null;
  next_action: string | null;
  raw_status: number | string | null;
  last_event_type: string | null;
  can_dismiss: boolean;
  can_repair_to_idle: boolean;
  can_repair_to_blocked: boolean;
}

export interface RuntimeRecoverySummary {
  total: number;
  running: number;
  blocked: number;
  idle: number;
  dismissed: number;
  cooling_down: number;
  failed_recently: number;
}

export interface RuntimeRecoveryResponse {
  scope_kind: "project" | "workflow";
  scope_id: string;
  generated_at: string;
  summary: RuntimeRecoverySummary;
  items: RuntimeRecoveryItem[];
}

export type TaskState = "PLANNED" | "READY" | "DISPATCHED" | "IN_PROGRESS" | "BLOCKED_DEP" | "DONE" | "CANCELED";

export type TaskKind = "PROJECT_ROOT" | "USER_ROOT" | "EXECUTION";
export type ReminderMode = "backoff" | "fixed_interval";

export interface TaskTreeNode {
  task_id: string;
  task_detail_id?: string;
  task_kind: TaskKind;
  parent_task_id: string | null;
  root_task_id: string | null;
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
  last_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskDetail {
  project_id: string;
  task_id: string;
  task_detail_id: string;
  task: TaskTreeNode;
  created_by: {
    role: string;
    session_id?: string;
  };
  create_parameters?: Record<string, unknown>;
  lifecycle: TaskLifecycleEvent[];
  stats: {
    lifecycle_event_count: number;
  };
}

export interface TaskLifecycleEvent {
  event_type: string;
  source: string;
  created_at: string;
  payload: Record<string, unknown>;
}

export interface TaskTreeEdge {
  from_task_id: string;
  to_task_id: string;
  relation: "DEPENDS_ON" | "PARENT_OF" | "PARENT_CHILD";
  edge_type?: string;
  external?: boolean;
}

export interface TaskTreeResponse {
  project_id: string;
  generated_at: string;
  query: {
    focus_task_id?: string;
    max_descendant_depth?: number;
    include_external_dependencies?: boolean;
  };
  roots: string[];
  focus: TaskTreeNode | null;
  nodes: TaskTreeNode[];
  edges: TaskTreeEdge[];
  stats: {
    node_count: number;
    edge_count: number;
    external_dependency_edge_count: number;
  };
}

export interface LockRecord {
  lockId: string;
  lockKey: string;
  ownerSessionId: string;
  targetType?: "file" | "dir" | "unknown";
  purpose?: string;
  ttlSeconds: number;
  renewCount: number;
  acquiredAt: string;
  expiresAt: string;
  status: "active" | "released" | "expired";
  stealReason?: string;
  stolenFromSessionId?: string;
}

export interface AgentDefinition {
  agentId: string;
  displayName: string;
  prompt: string;
  summary?: string;
  skillList?: string[];
  updatedAt: string;
  defaultCliTool?: ProviderId;
  defaultModelParams?: Record<string, unknown>;
  modelSelectionEnabled?: boolean;
  createdAt?: string;
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

export interface SkillImportItem {
  skill: SkillDefinition;
  action: "created" | "updated";
  warnings: string[];
}

export interface SkillImportResult {
  imported: SkillImportItem[];
  warnings: string[];
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

export interface AgentTemplateDefinition {
  templateId: string;
  displayName: string;
  prompt: string;
  source: "built-in" | "custom";
  basedOnTemplateId?: string | null;
}

export interface TemplateDefinition {
  templateId: string;
  name: string;
  description?: string;
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

export interface OrchestratorStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  totalDispatches: number;
  pendingMessages: number;
  dispatchedMessages: number;
  failedDispatches: number;
  lastTick: string;
}

export interface MCPServerConfig {
  name: string;
  type: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  connectTimeout?: number;
  executeTimeout?: number;
}

export interface RuntimeSettings {
  codexCliCommand?: string;
  theme?: Theme;
  hostPlatform?: "win32" | "linux" | "darwin";
  hostPlatformLabel?: string;
  supportedShellTypes?: Array<"powershell" | "cmd" | "bash" | "sh">;
  defaultShellType?: "powershell" | "cmd" | "bash" | "sh";
  codexCliCommandDefault?: string;
  macosUntested?: boolean;
  minimaxApiKey?: string;
  minimaxApiBase?: string;
  minimaxModel?: string;
  minimaxSessionDir?: string;
  minimaxMcpServers?: MCPServerConfig[];
  minimaxMaxSteps?: number;
  minimaxTokenLimit?: number;
  updatedAt?: string;
}

export interface ModelInfo {
  vendor: string;
  model: string;
  description?: string;
}

export interface ModelsResponse {
  models: ModelInfo[];
  warnings?: string[];
  source?: "cache" | "refresh" | "fallback-mixed";
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
  action_type: TaskActionType;
  from_agent: string;
  from_session_id?: string | null;
  to_role?: string;
  to_session_id?: string | null;
  payload: {
    task_id?: string;
    title?: string;
    parent_task_id?: string;
    owner_role?: string;
    dependencies?: string[];
    acceptance?: string[];
    write_set?: string[];
    state?: string;
    content?: string;
    thread_id?: string;
    round?: number;
    summary?: string;
    artifacts?: string[];
    alert?: string;
  };
}

export interface TaskPatchRequest {
  title?: string;
  state?: TaskState;
  owner_role?: string;
  dependencies?: string[];
  write_set?: string[];
  acceptance?: string[];
  artifacts?: string[];
  priority?: number;
  alert?: string | null;
}

export interface SendMessageRequest {
  from_agent: string;
  to: {
    agent: string;
    session_id?: string | null;
  };
  content: string;
  message_type?: "MANAGER_MESSAGE" | "TASK_DISCUSS_REQUEST" | "TASK_DISCUSS_REPLY" | "TASK_DISCUSS_CLOSED";
  task_id?: string;
  thread_id?: string;
  round?: number;
}

export interface CreateProjectRequest {
  project_id: string;
  name: string;
  workspace_path: string;
  template_id?: string;
  team_id?: string;
  agent_ids?: string[];
  route_table?: Record<string, string[]>;
  route_discuss_rounds?: number;
  role_session_map?: Record<string, string>;
  auto_dispatch_enabled?: boolean;
  auto_dispatch_remaining?: number;
}

export interface RoutingConfigRequest {
  agent_ids?: string[];
  route_table?: Record<string, string[]>;
  route_discuss_rounds?: Record<string, Record<string, number>>;
  agent_model_configs?: Record<string, AgentModelConfig>;
}

export interface DispatchResult {
  sessionId: string;
  role?: string;
  outcome?: string;
  dispatchKind?: string;
  messageId?: string;
  requestId?: string;
  runId?: string;
  taskId?: string;
  exitCode?: number;
  timedOut?: boolean;
  error?: string;
  dispatched?: boolean;
  reason?: string;
}

export type ProjectView =
  | "timeline"
  | "chat"
  | "recovery"
  | "session-manager"
  | "agent-io"
  | "agent-chat"
  | "taskboard"
  | "task-tree"
  | "task-create"
  | "task-update"
  | "lock-manager"
  | "team-config"
  | "project-settings";

export type AgentView = "sessions" | "agents" | "templates";

export type DebugView = "agent-sessions" | "session-prompts" | "agent-output";

export type TeamView = "list" | "edit" | "new";
export type WorkflowRunWorkspaceView = "overview" | "task-tree" | "chat" | "agent-chat" | "team-config" | "recovery";
export type WorkflowView = "runs" | "new-run" | "run-workspace" | "templates" | "new-template" | "edit-template";
export type SkillView = "library" | "lists";

export interface TeamRecord {
  schemaVersion: "1.0";
  teamId: string;
  name: string;
  description?: string;
  agentIds: string[];
  routeTable: Record<string, string[]>;
  taskAssignRouteTable: Record<string, string[]>;
  routeDiscussRounds: Record<string, Record<string, number>>;
  agentModelConfigs: Record<string, AgentModelConfig>;
  createdAt: string;
  updatedAt: string;
}

export interface TeamSummary {
  teamId: string;
  name: string;
  description?: string;
  agentCount: number;
  createdAt: string;
  updatedAt: string;
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

export interface WorkflowRunTaskRecord extends WorkflowTemplateTaskRecord {
  resolvedTitle: string;
  creatorRole?: string;
  creatorSessionId?: string;
}

export type WorkflowRunState = "created" | "running" | "stopped" | "finished" | "failed";
export type WorkflowRunMode = "none" | "loop" | "schedule";

export interface WorkflowRunSpawnState {
  isActive?: boolean;
  activeRunId?: string;
  lastWindowKey?: string;
  lastSpawnedRunId?: string;
  lastSpawnedAt?: string;
  lastTriggeredAt?: string;
  lastWindowStartAt?: string;
  lastWindowEndAt?: string;
  nextAvailableAt?: string;
}

export type WorkflowTaskState =
  | "PLANNED"
  | "READY"
  | "DISPATCHED"
  | "IN_PROGRESS"
  | "BLOCKED_DEP"
  | "DONE"
  | "CANCELED";

export type WorkflowTaskOutcome = "IN_PROGRESS" | "BLOCKED_DEP" | "DONE" | "CANCELED";

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
  mode?: WorkflowRunMode;
  loopEnabled?: boolean;
  scheduleEnabled?: boolean;
  scheduleExpression?: string;
  isScheduleSeed?: boolean;
  originRunId?: string;
  lastSpawnedRunId?: string;
  spawnState?: WorkflowRunSpawnState;
  autoDispatchEnabled?: boolean;
  autoDispatchRemaining?: number;
  autoDispatchInitialRemaining?: number;
  holdEnabled?: boolean;
  reminderMode?: ReminderMode;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stoppedAt?: string;
  lastHeartbeatAt?: string;
  runtime?: {
    initializedAt: string;
    updatedAt: string;
    transitionSeq: number;
    tasks: WorkflowTaskRuntimeRecord[];
  };
}

export interface WorkflowRunOrchestratorSettings {
  run_id: string;
  mode: WorkflowRunMode;
  loop_enabled: boolean;
  schedule_enabled: boolean;
  schedule_expression?: string;
  is_schedule_seed: boolean;
  origin_run_id?: string;
  last_spawned_run_id?: string;
  spawn_state?: WorkflowRunSpawnState;
  auto_dispatch_enabled: boolean;
  auto_dispatch_remaining: number;
  auto_dispatch_initial_remaining: number;
  hold_enabled: boolean;
  reminder_mode: "backoff" | "fixed_interval";
  recurring_status: {
    occupied: boolean;
    active_run_id?: string;
    next_trigger_at?: string;
    last_triggered_at?: string;
  };
  updated_at: string;
}

export interface WorkflowRunRuntimeStatus {
  runId: string;
  status: WorkflowRunState;
  active: boolean;
  startedAt?: string;
  stoppedAt?: string;
  lastHeartbeatAt?: string;
}

export interface WorkflowOrchestratorStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  maxConcurrentDispatches?: number;
  inFlightDispatchSessions: number;
  lastTickAt: string | null;
  started: boolean;
  activeRunIds: string[];
  activeRunCount: number;
  runs?: Array<{
    runId: string;
    autoDispatchEnabled: boolean;
    autoDispatchRemaining: number;
    holdEnabled: boolean;
    reminderMode: ReminderMode;
  }>;
}

export interface WorkflowRunRuntimeCounters {
  total: number;
  planned: number;
  ready: number;
  dispatched: number;
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

export interface WorkflowTaskTreeRuntimeNode extends WorkflowRunTaskRecord {
  runtime: WorkflowTaskRuntimeRecord | null;
}

export interface WorkflowTaskTreeRuntimeEdge {
  from_task_id: string;
  to_task_id: string;
  relation: "PARENT_CHILD" | "DEPENDS_ON";
}

export interface WorkflowTaskTreeRuntimeResponse {
  run_id: string;
  generated_at: string;
  status: WorkflowRunState;
  active: boolean;
  roots: string[];
  nodes: WorkflowTaskTreeRuntimeNode[];
  edges: WorkflowTaskTreeRuntimeEdge[];
  counters: WorkflowRunRuntimeCounters;
}

export type WorkflowTaskActionType =
  | "TASK_CREATE"
  | "TASK_DISCUSS_REQUEST"
  | "TASK_DISCUSS_REPLY"
  | "TASK_DISCUSS_CLOSED"
  | "TASK_REPORT";

export interface WorkflowTaskActionRequest {
  action_type: WorkflowTaskActionType;
  from_agent?: string;
  from_session_id?: string;
  to_role?: string;
  to_session_id?: string;
  task_id?: string;
  content?: string;
  task?: {
    task_id: string;
    title: string;
    owner_role: string;
    parent_task_id?: string;
    dependencies?: string[];
    acceptance?: string[];
    artifacts?: string[];
  };
  discuss?: {
    thread_id?: string;
    request_id?: string;
  };
  results?: Array<{
    task_id: string;
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

export interface CreateTeamRequest {
  team_id: string;
  name: string;
  description?: string;
  agent_ids?: string[];
  route_table?: Record<string, string[]>;
  task_assign_route_table?: Record<string, string[]>;
  route_discuss_rounds?: Record<string, Record<string, number>>;
  agent_model_configs?: Record<string, AgentModelConfig>;
}

export interface UpdateTeamRequest {
  name?: string;
  description?: string;
  agent_ids?: string[];
  route_table?: Record<string, string[]>;
  task_assign_route_table?: Record<string, string[]>;
  route_discuss_rounds?: Record<string, Record<string, number>>;
  agent_model_configs?: Record<string, AgentModelConfig>;
}

export type L1Route =
  | { l1: "home" }
  | { l1: "new-project" }
  | { l1: "projects" }
  | { l1: "project"; projectId: string; view?: ProjectView }
  | { l1: "teams"; view?: TeamView; teamId?: string }
  | { l1: "workflow"; view?: WorkflowView; runId?: string; runView?: WorkflowRunWorkspaceView; templateId?: string }
  | { l1: "skills"; view?: SkillView }
  | { l1: "agents"; view?: AgentView }
  | { l1: "debug"; debugView?: DebugView }
  | { l1: "settings" };

export type Theme = "dark" | "vibrant" | "lively";
