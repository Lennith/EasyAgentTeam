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
  roleSessionMap?: Record<string, string>;
}

export interface OrchestratorSettings {
  project_id: string;
  auto_dispatch_enabled: boolean;
  auto_dispatch_remaining: number;
  updated_at: string;
}

export interface AgentModelConfig {
  tool: "codex" | "trae" | "minimax";
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
  updatedAt: string;
  defaultCliTool?: "codex" | "trae" | "minimax";
  defaultModelParams?: Record<string, unknown>;
  modelSelectionEnabled?: boolean;
  createdAt?: string;
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
  type: 'stdio' | 'sse' | 'http';
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
  traeCliCommand?: string;
  theme?: Theme;
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

export type DebugView = "agent-sessions" | "session-prompts" | "codex-output";

export type TeamView = "list" | "edit" | "new";

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
  | { l1: "agents"; view?: AgentView }
  | { l1: "debug"; debugView?: DebugView }
  | { l1: "settings" };

export type Theme = "dark" | "vibrant" | "lively";
