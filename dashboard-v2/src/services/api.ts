import type {
  ProjectSummary,
  ProjectDetail,
  SessionRecord,
  TaskTreeResponse,
  TaskTreeNode,
  TaskDetail,
  LockRecord,
  EventRecord,
  AgentDefinition,
  AgentTemplateDefinition,
  TemplateDefinition,
  AgentIOTimelineItem,
  OrchestratorStatus,
  OrchestratorSettings,
  RuntimeSettings,
  ModelInfo,
  SendMessageRequest,
  CreateProjectRequest,
  RoutingConfigRequest,
  DispatchResult,
  TaskActionRequest,
  TaskPatchRequest,
  TeamRecord,
  TeamSummary,
  CreateTeamRequest,
  UpdateTeamRequest,
  WorkflowTemplateRecord,
  WorkflowRunRecord,
  WorkflowRunRuntimeCounters,
  WorkflowRunRuntimeStatus,
  WorkflowRunRuntimeSnapshot,
  WorkflowTaskRuntimeRecord,
  WorkflowTaskTransitionRecord,
  WorkflowTaskTreeRuntimeNode,
  WorkflowTaskTreeRuntimeResponse,
  WorkflowTaskActionRequest,
  WorkflowTaskActionResult,
  WorkflowOrchestratorStatus,
  WorkflowRunMode,
  WorkflowRunOrchestratorSettings,
  RuntimeRecoveryItem,
  RuntimeRecoveryResponse,
  RuntimeRecoverySummary,
  WorkflowSessionRecord,
  SkillDefinition,
  SkillImportResult,
  SkillListDefinition
} from "@/types";
import type { ProviderId } from "@autodev/agent-library";

const API_BASE = "/api";
const RECOVERY_CENTER_ATTEMPT_LIMIT = 5;

function formatError(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    try {
      return JSON.stringify(error);
    } catch {
      return "[object Object]";
    }
  }
  return String(error);
}

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options
  });
  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!response.ok) {
    throw new Error(formatError((data as { error?: unknown }).error) ?? `HTTP ${response.status}`);
  }
  return data as T;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    let data: unknown = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    throw new Error(formatError((data as { error?: unknown }).error) ?? `HTTP ${response.status}`);
  }
  return response.text();
}

async function readApiError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `HTTP ${response.status}`;
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    return formatError(parsed.error) ?? formatError(parsed.message) ?? `HTTP ${response.status}`;
  } catch {
    return text;
  }
}

async function fetchStream(url: string, options?: RequestInit): Promise<Response> {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
  return response;
}

const TASK_STATES = new Set<TaskTreeNode["state"]>([
  "PLANNED",
  "READY",
  "DISPATCHED",
  "IN_PROGRESS",
  "BLOCKED_DEP",
  "DONE",
  "CANCELED"
]);

const WORKFLOW_TASK_STATES = new Set<WorkflowTaskRuntimeRecord["state"]>([
  "PLANNED",
  "READY",
  "DISPATCHED",
  "IN_PROGRESS",
  "BLOCKED_DEP",
  "DONE",
  "CANCELED"
]);

function normalizeTaskState(state: unknown): TaskTreeNode["state"] {
  if (typeof state === "string" && TASK_STATES.has(state as TaskTreeNode["state"])) {
    return state as TaskTreeNode["state"];
  }
  return "PLANNED";
}

function normalizeWorkflowTaskState(state: unknown): WorkflowTaskRuntimeRecord["state"] {
  if (typeof state === "string" && WORKFLOW_TASK_STATES.has(state as WorkflowTaskRuntimeRecord["state"])) {
    return state as WorkflowTaskRuntimeRecord["state"];
  }
  return "PLANNED";
}

function normalizeTaskTreeNode(node: TaskTreeNode): TaskTreeNode {
  return {
    ...node,
    state: normalizeTaskState(node.state)
  };
}

function normalizeTaskTreeResponse(response: TaskTreeResponse): TaskTreeResponse {
  return {
    ...response,
    focus: response.focus ? normalizeTaskTreeNode(response.focus) : null,
    nodes: (response.nodes ?? []).map(normalizeTaskTreeNode)
  };
}

function normalizeTaskDetail(detail: TaskDetail): TaskDetail {
  return {
    ...detail,
    task: normalizeTaskTreeNode(detail.task)
  };
}

function normalizeWorkflowTaskTransitionRecord(transition: WorkflowTaskTransitionRecord): WorkflowTaskTransitionRecord {
  return {
    ...transition,
    fromState: transition.fromState ? normalizeWorkflowTaskState(transition.fromState) : null,
    toState: normalizeWorkflowTaskState(transition.toState)
  };
}

function normalizeWorkflowTaskRuntimeRecord(record: WorkflowTaskRuntimeRecord): WorkflowTaskRuntimeRecord {
  return {
    ...record,
    state: normalizeWorkflowTaskState(record.state),
    transitions: (record.transitions ?? []).map(normalizeWorkflowTaskTransitionRecord)
  };
}

function normalizeWorkflowRunRuntimeCounters(counters: WorkflowRunRuntimeCounters): WorkflowRunRuntimeCounters {
  return counters;
}

function normalizeWorkflowRunRuntimeSnapshot(snapshot: WorkflowRunRuntimeSnapshot): WorkflowRunRuntimeSnapshot {
  return {
    ...snapshot,
    counters: normalizeWorkflowRunRuntimeCounters(snapshot.counters),
    tasks: (snapshot.tasks ?? []).map(normalizeWorkflowTaskRuntimeRecord)
  };
}

function normalizeWorkflowTaskTreeRuntimeNode(node: WorkflowTaskTreeRuntimeNode): WorkflowTaskTreeRuntimeNode {
  return {
    ...node,
    runtime: node.runtime ? normalizeWorkflowTaskRuntimeRecord(node.runtime) : null
  };
}

function normalizeWorkflowTaskTreeRuntimeResponse(
  response: WorkflowTaskTreeRuntimeResponse
): WorkflowTaskTreeRuntimeResponse {
  return {
    ...response,
    counters: normalizeWorkflowRunRuntimeCounters(response.counters),
    nodes: (response.nodes ?? []).map(normalizeWorkflowTaskTreeRuntimeNode)
  };
}

function normalizeWorkflowRunRecord(run: WorkflowRunRecord): WorkflowRunRecord {
  return {
    ...run,
    runtime: run.runtime
      ? {
          ...run.runtime,
          tasks: (run.runtime.tasks ?? []).map(normalizeWorkflowTaskRuntimeRecord)
        }
      : run.runtime
  };
}

function mapSessionFields(raw: Record<string, unknown>): SessionRecord {
  return {
    sessionId: (raw.sessionId ?? raw.session_id ?? raw.sessionKey) as string,
    projectId: (raw.projectId ?? raw.project_id) as string,
    role: raw.role as string,
    status: raw.status as SessionRecord["status"],
    createdAt: (raw.createdAt ?? raw.created_at) as string,
    updatedAt: (raw.updatedAt ?? raw.updated_at) as string,
    currentTaskId: (raw.currentTaskId ?? raw.current_task_id) as string | undefined,
    lastHeartbeat: (raw.lastActiveAt ?? raw.last_heartbeat ?? raw.lastHeartbeat) as string | undefined,
    lastActiveAt: (raw.lastActiveAt ?? raw.last_active_at) as string | undefined,
    lastDispatchedAt: (raw.lastDispatchedAt ?? raw.last_dispatched_at) as string | undefined,
    agentTool: raw.agentTool as string | undefined,
    sessionKey: raw.sessionKey as string | undefined,
    providerSessionId: raw.providerSessionId as string | null | undefined,
    provider: raw.provider as string | undefined,
    locksHeldCount: raw.locksHeldCount as number | undefined
  };
}

function mapEventFields(raw: Record<string, unknown>): EventRecord {
  return {
    eventId: (raw.eventId ?? raw.event_id) as string,
    eventType: (raw.eventType ?? raw.event_type) as string,
    source: raw.source as string,
    createdAt: (raw.createdAt ?? raw.created_at) as string,
    sessionId: (raw.sessionId ?? raw.session_id) as string | undefined,
    payload: (raw.payload ?? {}) as Record<string, unknown>
  };
}

function mapSkillDefinition(raw: Record<string, unknown>): SkillDefinition {
  return {
    schemaVersion: (raw.schemaVersion ?? raw.schema_version ?? "1.0") as "1.0",
    skillId: (raw.skillId ?? raw.skill_id) as string,
    name: raw.name as string,
    description: raw.description as string,
    license: raw.license as string,
    compatibility: raw.compatibility as string,
    sourceType: (raw.sourceType ?? raw.source_type) as "opencode" | "codex" | "local",
    sourcePath: (raw.sourcePath ?? raw.source_path) as string,
    packagePath: (raw.packagePath ?? raw.package_path) as string,
    entryFile: (raw.entryFile ?? raw.entry_file ?? "SKILL.md") as string,
    warnings: raw.warnings as string[] | undefined,
    createdAt: (raw.createdAt ?? raw.created_at) as string,
    updatedAt: (raw.updatedAt ?? raw.updated_at) as string
  };
}

function mapSkillListDefinition(raw: Record<string, unknown>): SkillListDefinition {
  return {
    schemaVersion: (raw.schemaVersion ?? raw.schema_version ?? "1.0") as "1.0",
    listId: (raw.listId ?? raw.list_id) as string,
    displayName: (raw.displayName ?? raw.display_name) as string,
    description: raw.description as string | undefined,
    includeAll: (raw.includeAll ?? raw.include_all ?? false) as boolean,
    skillIds: (raw.skillIds ?? raw.skill_ids ?? []) as string[],
    createdAt: (raw.createdAt ?? raw.created_at) as string,
    updatedAt: (raw.updatedAt ?? raw.updated_at) as string
  };
}

function mapWorkflowSessionFields(raw: Record<string, unknown>): WorkflowSessionRecord {
  return {
    schemaVersion: (raw.schemaVersion ?? raw.schema_version ?? "1.0") as "1.0",
    sessionId: (raw.sessionId ?? raw.session_id ?? raw.sessionKey) as string,
    runId: (raw.runId ?? raw.run_id) as string,
    role: raw.role as string,
    provider: (raw.provider ?? raw.provider_id) as ProviderId,
    providerSessionId:
      (raw.providerSessionId ?? raw.provider_session_id) === null
        ? null
        : ((raw.providerSessionId ?? raw.provider_session_id) as string | undefined),
    status: raw.status as WorkflowSessionRecord["status"],
    createdAt: (raw.createdAt ?? raw.created_at) as string,
    updatedAt: (raw.updatedAt ?? raw.updated_at) as string,
    lastActiveAt: (raw.lastActiveAt ?? raw.last_active_at) as string,
    currentTaskId: (raw.currentTaskId ?? raw.current_task_id) as string | undefined,
    lastInboxMessageId: (raw.lastInboxMessageId ?? raw.last_inbox_message_id) as string | undefined,
    lastDispatchedAt: (raw.lastDispatchedAt ?? raw.last_dispatched_at) as string | undefined,
    lastDispatchId: (raw.lastDispatchId ?? raw.last_dispatch_id) as string | undefined,
    lastDispatchedMessageId: (raw.lastDispatchedMessageId ?? raw.last_dispatched_message_id) as string | undefined
  };
}

function mapRuntimeRecoveryItem(raw: Record<string, unknown>): RuntimeRecoveryItem {
  return {
    role: String(raw.role ?? ""),
    session_id: String(raw.session_id ?? ""),
    provider: String(raw.provider ?? ""),
    provider_session_id:
      raw.provider_session_id === null ? null : ((raw.provider_session_id as string | undefined) ?? null),
    status: raw.status as RuntimeRecoveryItem["status"],
    current_task_id: (raw.current_task_id as string | null | undefined) ?? null,
    current_task_title: (raw.current_task_title as string | null | undefined) ?? null,
    current_task_state: (raw.current_task_state as string | null | undefined) ?? null,
    role_session_mapping:
      (raw.role_session_mapping as RuntimeRecoveryItem["role_session_mapping"] | undefined) ?? "none",
    cooldown_until: (raw.cooldown_until as string | null | undefined) ?? null,
    last_failure_at: (raw.last_failure_at as string | null | undefined) ?? null,
    last_failure_kind: (raw.last_failure_kind as RuntimeRecoveryItem["last_failure_kind"] | undefined) ?? null,
    last_failure_event_id: (raw.last_failure_event_id as string | null | undefined) ?? null,
    last_failure_dispatch_id: (raw.last_failure_dispatch_id as string | null | undefined) ?? null,
    last_failure_message_id: (raw.last_failure_message_id as string | null | undefined) ?? null,
    last_failure_task_id: (raw.last_failure_task_id as string | null | undefined) ?? null,
    error_streak: Number(raw.error_streak ?? 0),
    timeout_streak: Number(raw.timeout_streak ?? 0),
    retryable: typeof raw.retryable === "boolean" ? raw.retryable : null,
    code: (raw.code as string | null | undefined) ?? null,
    message: (raw.message as string | null | undefined) ?? null,
    next_action: (raw.next_action as string | null | undefined) ?? null,
    raw_status: typeof raw.raw_status === "number" || typeof raw.raw_status === "string" ? raw.raw_status : null,
    last_event_type: (raw.last_event_type as string | null | undefined) ?? null,
    can_dismiss: Boolean(raw.can_dismiss),
    can_repair_to_idle: Boolean(raw.can_repair_to_idle),
    can_repair_to_blocked: Boolean(raw.can_repair_to_blocked),
    can_retry_dispatch: Boolean(raw.can_retry_dispatch),
    disabled_reason: (raw.disabled_reason as string | null | undefined) ?? null,
    risk: (raw.risk as string | null | undefined) ?? null,
    requires_confirmation: Boolean(raw.requires_confirmation),
    latest_events: Array.isArray(raw.latest_events)
      ? raw.latest_events.map((event) => ({
          event_type: String((event as Record<string, unknown>).event_type ?? ""),
          created_at: String((event as Record<string, unknown>).created_at ?? ""),
          payload_summary: String((event as Record<string, unknown>).payload_summary ?? "")
        }))
      : [],
    recovery_attempts: Array.isArray(raw.recovery_attempts)
      ? raw.recovery_attempts.map((attempt) => {
          const item = attempt as Record<string, unknown>;
          return {
            recovery_attempt_id: String(item.recovery_attempt_id ?? ""),
            status:
              (item.status as RuntimeRecoveryItem["recovery_attempts"][number]["status"] | undefined) ?? "requested",
            integrity:
              (item.integrity as RuntimeRecoveryItem["recovery_attempts"][number]["integrity"] | undefined) ??
              "incomplete",
            missing_markers: Array.isArray(item.missing_markers)
              ? item.missing_markers
                  .filter((marker): marker is string => typeof marker === "string")
                  .map(
                    (marker) => marker as RuntimeRecoveryItem["recovery_attempts"][number]["missing_markers"][number]
                  )
              : [],
            requested_at: (item.requested_at as string | null | undefined) ?? null,
            last_event_at: String(item.last_event_at ?? ""),
            ended_at: (item.ended_at as string | null | undefined) ?? null,
            dispatch_scope:
              (item.dispatch_scope as RuntimeRecoveryItem["recovery_attempts"][number]["dispatch_scope"] | undefined) ??
              null,
            current_task_id: (item.current_task_id as string | null | undefined) ?? null,
            events: Array.isArray(item.events)
              ? item.events.map((event) => ({
                  event_type: String((event as Record<string, unknown>).event_type ?? ""),
                  created_at: String((event as Record<string, unknown>).created_at ?? ""),
                  payload_summary: String((event as Record<string, unknown>).payload_summary ?? "")
                }))
              : []
          };
        })
      : []
  };
}

function mapRuntimeRecoverySummary(raw: Record<string, unknown>): RuntimeRecoverySummary {
  return {
    all_sessions_total: Number(raw.all_sessions_total ?? 0),
    recovery_candidates_total: Number(raw.recovery_candidates_total ?? 0),
    running: Number(raw.running ?? 0),
    blocked: Number(raw.blocked ?? 0),
    idle: Number(raw.idle ?? 0),
    dismissed: Number(raw.dismissed ?? 0),
    cooling_down: Number(raw.cooling_down ?? 0),
    failed_recently: Number(raw.failed_recently ?? 0)
  };
}

function mapRuntimeRecoveryResponse(raw: Record<string, unknown>): RuntimeRecoveryResponse {
  return {
    scope_kind: raw.scope_kind as RuntimeRecoveryResponse["scope_kind"],
    scope_id: String(raw.scope_id ?? ""),
    generated_at: String(raw.generated_at ?? ""),
    summary: mapRuntimeRecoverySummary((raw.summary ?? {}) as Record<string, unknown>),
    items: Array.isArray(raw.items)
      ? raw.items.map((item) => mapRuntimeRecoveryItem(item as Record<string, unknown>))
      : []
  };
}

function buildRetryDispatchGuardBody(
  item: RuntimeRecoveryItem,
  reason: string,
  confirm?: boolean
): Record<string, unknown> {
  return {
    reason,
    actor: "dashboard",
    expected_status: "idle",
    expected_role_mapping: item.role_session_mapping,
    ...(item.current_task_id ? { expected_current_task_id: item.current_task_id } : {}),
    ...(item.last_failure_at ? { expected_last_failure_at: item.last_failure_at } : {}),
    ...(item.last_failure_event_id ? { expected_last_failure_event_id: item.last_failure_event_id } : {}),
    ...(item.last_failure_dispatch_id ? { expected_last_failure_dispatch_id: item.last_failure_dispatch_id } : {}),
    ...(item.last_failure_message_id ? { expected_last_failure_message_id: item.last_failure_message_id } : {}),
    ...(item.last_failure_task_id ? { expected_last_failure_task_id: item.last_failure_task_id } : {}),
    ...(confirm ? { confirm: true } : {})
  };
}

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

export const projectApi = {
  list: () => fetchJSON<{ items: ProjectSummary[] }>(`${API_BASE}/projects`),

  get: (projectId: string) => fetchJSON<ProjectDetail>(`${API_BASE}/projects/${encodeURIComponent(projectId)}`),

  create: (data: CreateProjectRequest) =>
    fetchJSON<{ projectId: string }>(`${API_BASE}/projects`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  delete: (projectId: string) =>
    fetchJSON<{ success: boolean }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE"
    }),

  getEvents: async (projectId: string, since?: string): Promise<EventRecord[]> => {
    const url = since
      ? `${API_BASE}/projects/${encodeURIComponent(projectId)}/events?since=${encodeURIComponent(since)}`
      : `${API_BASE}/projects/${encodeURIComponent(projectId)}/events`;
    const text = await fetchText(url);
    const lines = text.split("\n").filter((line) => line.trim());
    return lines.map((line) => mapEventFields(JSON.parse(line)));
  },

  getSessions: async (projectId: string): Promise<{ items: SessionRecord[] }> => {
    const data = await fetchJSON<{ items: Record<string, unknown>[] }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions`
    );
    return { items: (data.items ?? []).map(mapSessionFields) };
  },

  getRuntimeRecovery: async (projectId: string): Promise<RuntimeRecoveryResponse> =>
    mapRuntimeRecoveryResponse(
      await fetchJSON<Record<string, unknown>>(
        `${API_BASE}/projects/${encodeURIComponent(projectId)}/runtime-recovery?attempt_limit=${RECOVERY_CENTER_ATTEMPT_LIMIT}`
      )
    ),

  getTaskTree: (
    projectId: string,
    options?: {
      focus_task_id?: string;
      max_descendant_depth?: number;
      include_external_dependencies?: boolean;
    }
  ) => {
    const params = new URLSearchParams();
    if (options?.focus_task_id) params.set("focus_task_id", options.focus_task_id);
    if (options?.max_descendant_depth) params.set("max_descendant_depth", String(options.max_descendant_depth));
    if (options?.include_external_dependencies !== undefined)
      params.set("include_external_dependencies", String(options.include_external_dependencies));
    const query = params.toString();
    const url = `${API_BASE}/projects/${encodeURIComponent(projectId)}/task-tree${query ? `?${query}` : ""}`;
    return fetchJSON<TaskTreeResponse>(url).then(normalizeTaskTreeResponse);
  },

  getTaskDetail: (projectId: string, taskId: string) =>
    fetchJSON<TaskDetail>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/detail`
    ).then(normalizeTaskDetail),

  taskAction: (projectId: string, data: TaskActionRequest) =>
    fetchJSON<{ taskId?: string; success: boolean }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/task-actions`,
      {
        method: "POST",
        body: JSON.stringify(data)
      }
    ),

  patchTask: (projectId: string, taskId: string, data: TaskPatchRequest) =>
    fetchJSON<{ success: boolean; task: TaskTreeNode }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(data)
      }
    ).then((payload) => ({
      ...payload,
      task: normalizeTaskTreeNode(payload.task)
    })),

  getLocks: (projectId: string) =>
    fetchJSON<{ items: LockRecord[] }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/locks`),

  acquireLock: (
    projectId: string,
    data: { session_id: string; target_type: "file" | "dir"; lock_key: string; ttl_seconds: number; purpose?: string }
  ) =>
    fetchJSON<{ result: string }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/locks/acquire`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  renewLock: (projectId: string, data: { session_id: string; lock_key: string }) =>
    fetchJSON<{ result: string }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/locks/renew`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  releaseLock: (projectId: string, data: { session_id: string; lock_key: string }) =>
    fetchJSON<{ result: string }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/locks/release`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  updateRoutingConfig: (projectId: string, data: RoutingConfigRequest) =>
    fetchJSON<ProjectDetail>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/routing-config`, {
      method: "PATCH",
      body: JSON.stringify(data)
    }),

  getTaskAssignRouting: (projectId: string) =>
    fetchJSON<{ project_id: string; task_assign_route_table: Record<string, string[]>; updated_at: string }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/task-assign-routing`
    ),

  updateTaskAssignRouting: (projectId: string, taskAssignRouteTable: Record<string, string[]>) =>
    fetchJSON<{ project_id: string; task_assign_route_table: Record<string, string[]>; updated_at: string }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/task-assign-routing`,
      {
        method: "PATCH",
        body: JSON.stringify({ task_assign_route_table: taskAssignRouteTable })
      }
    ),

  sendMessage: (projectId: string, data: SendMessageRequest) =>
    fetchJSON<{
      requestId: string;
      messageId: string;
      resolvedSessionId: string;
      messageType: string;
      buffered?: boolean;
    }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/messages/send`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  getAgentIOTimeline: async (projectId: string, limit?: number): Promise<{ items: AgentIOTimelineItem[] }> => {
    const url = limit
      ? `${API_BASE}/projects/${encodeURIComponent(projectId)}/agent-io/timeline?limit=${limit}`
      : `${API_BASE}/projects/${encodeURIComponent(projectId)}/agent-io/timeline`;
    try {
      const data = await fetchJSON<{ items: Record<string, unknown>[] }>(url);
      return {
        items: (data.items ?? []).map((raw) => ({
          id: (raw.itemId ?? raw.id ?? raw.ioId) as string,
          projectId: (raw.projectId ?? raw.project_id) as string,
          sessionId: (raw.sessionId ?? raw.session_id ?? raw.toSessionId) as string,
          role: (raw.role ?? raw.from ?? raw.toRole) as string,
          taskId: (raw.taskId ?? raw.task_id) as string | undefined,
          direction: (raw.direction ?? (raw.kind?.toString().includes("report") ? "outbound" : "inbound")) as
            | "inbound"
            | "outbound",
          messageType: (raw.messageType ?? raw.kind ?? raw.message_type) as string,
          summary: (raw.content ?? raw.summary) as string | undefined,
          createdAt: (raw.createdAt ?? raw.created_at) as string,
          from: raw.from as string | undefined,
          toRole: raw.toRole as string | undefined,
          sourceType: raw.sourceType as "user" | "agent" | "manager" | "system" | undefined,
          originAgent: raw.originAgent as string | undefined,
          kind: raw.kind as string | undefined,
          status: raw.status as string | undefined,
          runId: raw.runId as string | undefined
        }))
      };
    } catch {
      return { items: [] };
    }
  },

  dispatch: (
    projectId: string,
    data: { session_id?: string; force?: boolean; only_idle?: boolean; task_id?: string }
  ) =>
    fetchJSON<{ results: DispatchResult[] }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/orchestrator/dispatch`,
      {
        method: "POST",
        body: JSON.stringify(data)
      }
    ),

  dispatchMessage: (
    projectId: string,
    data: { message_id: string; session_id?: string; force?: boolean; only_idle?: boolean }
  ) =>
    fetchJSON<{ results: DispatchResult[] }>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/orchestrator/dispatch-message`,
      {
        method: "POST",
        body: JSON.stringify(data)
      }
    ),

  dismissSession: (projectId: string, sessionId: string, reason?: string, confirm?: boolean) =>
    fetchJSON<Record<string, unknown>>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/dismiss`,
      {
        method: "POST",
        body: JSON.stringify({
          reason: reason ?? "dashboard_manual_dismiss",
          actor: "dashboard",
          ...(confirm ? { confirm: true } : {})
        })
      }
    ),

  repairSession: (projectId: string, sessionId: string, targetStatus: "idle" | "blocked", confirm?: boolean) =>
    fetchJSON<Record<string, unknown>>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/repair`,
      {
        method: "POST",
        body: JSON.stringify({
          target_status: targetStatus,
          reason: "dashboard_manual_repair",
          actor: "dashboard",
          ...(confirm ? { confirm: true } : {})
        })
      }
    ),

  retryDispatchSession: (projectId: string, item: RuntimeRecoveryItem, confirm?: boolean) =>
    fetchJSON<Record<string, unknown>>(
      `${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(item.session_id)}/retry-dispatch`,
      {
        method: "POST",
        body: JSON.stringify(buildRetryDispatchGuardBody(item, "dashboard_manual_retry_dispatch", confirm))
      }
    ),

  registerSession: (projectId: string, data: { session_id: string; role: string; status?: string }) =>
    fetchJSON<{ success: boolean }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/sessions`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  getOrchestratorSettings: (projectId: string) =>
    fetchJSON<OrchestratorSettings>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/orchestrator/settings`),

  updateOrchestratorSettings: (
    projectId: string,
    data: {
      auto_dispatch_enabled?: boolean;
      auto_dispatch_remaining?: number;
      hold_enabled?: boolean;
      reminder_mode?: "backoff" | "fixed_interval";
    }
  ) =>
    fetchJSON<{
      project_id: string;
      auto_dispatch_enabled: boolean;
      auto_dispatch_remaining: number;
      hold_enabled: boolean;
      reminder_mode: "backoff" | "fixed_interval";
      updated_at: string;
    }>(`${API_BASE}/projects/${encodeURIComponent(projectId)}/orchestrator/settings`, {
      method: "PATCH",
      body: JSON.stringify(data)
    })
};

export const agentApi = {
  list: async () => {
    const data = await fetchJSON<{
      builtInItems?: Record<string, unknown>[];
      customItems?: Record<string, unknown>[];
      items?: Record<string, unknown>[];
    }>(`${API_BASE}/agents`);
    const agents: AgentDefinition[] = [];

    if (data.items) {
      agents.push(
        ...data.items.map((raw) => ({
          agentId: (raw.agentId ?? raw.agent_id) as string,
          displayName: (raw.displayName ?? raw.display_name) as string,
          prompt: raw.prompt as string,
          summary: raw.summary as string | undefined,
          skillList: (raw.skillList ?? raw.skill_list ?? []) as string[],
          updatedAt: (raw.updatedAt ?? raw.updated_at) as string,
          defaultCliTool: (raw.defaultCliTool ?? raw.default_cli_tool ?? raw.provider_id ?? raw.providerId) as
            | "codex"
            | "minimax"
            | undefined,
          defaultModelParams: raw.defaultModelParams as Record<string, unknown> | undefined,
          modelSelectionEnabled: raw.modelSelectionEnabled as boolean | undefined,
          createdAt: (raw.createdAt ?? raw.created_at) as string | undefined
        }))
      );
    }

    if (data.builtInItems) {
      agents.push(
        ...data.builtInItems.map((raw) => ({
          agentId: (raw.agentId ?? raw.agent_id) as string,
          displayName: (raw.displayName ?? raw.display_name) as string,
          prompt: raw.prompt as string,
          summary: raw.summary as string | undefined,
          skillList: (raw.skillList ?? raw.skill_list ?? []) as string[],
          updatedAt: (raw.updatedAt ?? raw.updated_at ?? new Date().toISOString()) as string,
          defaultCliTool: (raw.defaultCliTool ?? raw.default_cli_tool ?? raw.provider_id ?? raw.providerId) as
            | "codex"
            | "minimax"
            | undefined,
          defaultModelParams: raw.defaultModelParams as Record<string, unknown> | undefined,
          modelSelectionEnabled: raw.modelSelectionEnabled as boolean | undefined
        }))
      );
    }

    if (data.customItems) {
      agents.push(
        ...data.customItems.map((raw) => ({
          agentId: (raw.agentId ?? raw.agent_id) as string,
          displayName: (raw.displayName ?? raw.display_name) as string,
          prompt: raw.prompt as string,
          summary: raw.summary as string | undefined,
          skillList: (raw.skillList ?? raw.skill_list ?? []) as string[],
          updatedAt: (raw.updatedAt ?? raw.updated_at ?? new Date().toISOString()) as string,
          defaultCliTool: (raw.defaultCliTool ?? raw.default_cli_tool ?? raw.provider_id ?? raw.providerId) as
            | "codex"
            | "minimax"
            | undefined,
          defaultModelParams: raw.defaultModelParams as Record<string, unknown> | undefined,
          modelSelectionEnabled: raw.modelSelectionEnabled as boolean | undefined
        }))
      );
    }

    return { items: agents };
  },

  create: (data: {
    agent_id: string;
    display_name: string;
    prompt: string;
    summary?: string;
    skill_list?: string[];
    provider_id?: "codex" | "minimax";
  }) =>
    fetchJSON<{ agentId: string }>(`${API_BASE}/agents`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  update: (
    agentId: string,
    data: {
      display_name?: string;
      prompt?: string;
      summary?: string | null;
      skill_list?: string[];
      provider_id?: "codex" | "minimax";
    }
  ) =>
    fetchJSON<{ agentId: string }>(`${API_BASE}/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      body: JSON.stringify(data)
    }),

  delete: (agentId: string) =>
    fetchJSON<{ success: boolean }>(`${API_BASE}/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE"
    })
};

export const skillApi = {
  list: async (): Promise<{ items: SkillDefinition[]; total: number }> => {
    const data = await fetchJSON<{ items?: Record<string, unknown>[]; total?: number }>(`${API_BASE}/skills`);
    const items = (data.items ?? []).map(mapSkillDefinition);
    return { items, total: data.total ?? items.length };
  },

  import: async (data: { sources: string[]; recursive?: boolean }): Promise<SkillImportResult> => {
    const payload = await fetchJSON<{
      imported?: Array<{ skill: Record<string, unknown>; action: "created" | "updated"; warnings?: string[] }>;
      warnings?: string[];
    }>(`${API_BASE}/skills/import`, {
      method: "POST",
      body: JSON.stringify(data)
    });
    return {
      imported: (payload.imported ?? []).map((item) => ({
        skill: mapSkillDefinition(item.skill),
        action: item.action,
        warnings: item.warnings ?? []
      })),
      warnings: payload.warnings ?? []
    };
  },

  delete: (skillId: string) =>
    fetchJSON<SkillDefinition>(`${API_BASE}/skills/${encodeURIComponent(skillId)}`, {
      method: "DELETE"
    })
};

export const skillListApi = {
  list: async (): Promise<{ items: SkillListDefinition[]; total: number }> => {
    const data = await fetchJSON<{ items?: Record<string, unknown>[]; total?: number }>(`${API_BASE}/skill-lists`);
    const items = (data.items ?? []).map(mapSkillListDefinition);
    return { items, total: data.total ?? items.length };
  },

  create: async (data: {
    list_id: string;
    display_name?: string;
    description?: string;
    include_all?: boolean;
    skill_ids?: string[];
  }): Promise<SkillListDefinition> => {
    const payload = await fetchJSON<Record<string, unknown>>(`${API_BASE}/skill-lists`, {
      method: "POST",
      body: JSON.stringify(data)
    });
    return mapSkillListDefinition(payload);
  },

  update: async (
    listId: string,
    data: {
      display_name?: string;
      description?: string | null;
      include_all?: boolean;
      skill_ids?: string[];
    }
  ): Promise<SkillListDefinition> => {
    const payload = await fetchJSON<Record<string, unknown>>(`${API_BASE}/skill-lists/${encodeURIComponent(listId)}`, {
      method: "PATCH",
      body: JSON.stringify(data)
    });
    return mapSkillListDefinition(payload);
  },

  delete: (listId: string) =>
    fetchJSON<SkillListDefinition>(`${API_BASE}/skill-lists/${encodeURIComponent(listId)}`, {
      method: "DELETE"
    })
};

export const templateApi = {
  list: () =>
    fetchJSON<{ builtInItems?: AgentTemplateDefinition[]; customItems?: AgentTemplateDefinition[] }>(
      `${API_BASE}/agent-templates`
    ),

  create: (data: { template_id: string; display_name: string; prompt: string; based_on_template_id?: string | null }) =>
    fetchJSON<{ templateId: string }>(`${API_BASE}/agent-templates`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  update: (templateId: string, data: { display_name?: string; prompt?: string }) =>
    fetchJSON<{ templateId: string }>(`${API_BASE}/agent-templates/${encodeURIComponent(templateId)}`, {
      method: "PATCH",
      body: JSON.stringify(data)
    }),

  delete: (templateId: string) =>
    fetchJSON<{ success: boolean }>(`${API_BASE}/agent-templates/${encodeURIComponent(templateId)}`, {
      method: "DELETE"
    })
};

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

export const projectTemplateApi = {
  list: () => fetchJSON<{ items: TemplateDefinition[] }>(`${API_BASE}/project-templates`)
};

export const workflowApi = {
  listTemplates: () => fetchJSON<{ items: WorkflowTemplateRecord[]; total: number }>(`${API_BASE}/workflow-templates`),

  getTemplate: (templateId: string) =>
    fetchJSON<WorkflowTemplateRecord>(`${API_BASE}/workflow-templates/${encodeURIComponent(templateId)}`),

  createTemplate: (data: {
    template_id: string;
    name: string;
    description?: string;
    tasks: Array<{
      task_id: string;
      title: string;
      owner_role: string;
      parent_task_id?: string;
      dependencies?: string[];
      write_set?: string[];
      acceptance?: string[];
      artifacts?: string[];
    }>;
    route_table?: Record<string, string[]>;
    task_assign_route_table?: Record<string, string[]>;
    route_discuss_rounds?: Record<string, Record<string, number>>;
    default_variables?: Record<string, string>;
  }) =>
    fetchJSON<WorkflowTemplateRecord>(`${API_BASE}/workflow-templates`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  patchTemplate: (
    templateId: string,
    data: {
      name?: string;
      description?: string | null;
      tasks?: Array<{
        task_id: string;
        title: string;
        owner_role: string;
        parent_task_id?: string;
        dependencies?: string[];
        write_set?: string[];
        acceptance?: string[];
        artifacts?: string[];
      }>;
      route_table?: Record<string, string[]>;
      task_assign_route_table?: Record<string, string[]>;
      route_discuss_rounds?: Record<string, Record<string, number>>;
      default_variables?: Record<string, string>;
    }
  ) =>
    fetchJSON<WorkflowTemplateRecord>(`${API_BASE}/workflow-templates/${encodeURIComponent(templateId)}`, {
      method: "PATCH",
      body: JSON.stringify(data)
    }),

  deleteTemplate: (templateId: string) =>
    fetchJSON<{ templateId: string; removedAt: string }>(
      `${API_BASE}/workflow-templates/${encodeURIComponent(templateId)}`,
      {
        method: "DELETE"
      }
    ),

  listRuns: () =>
    fetchJSON<{ items: WorkflowRunRecord[]; total: number }>(`${API_BASE}/workflow-runs`).then((payload) => ({
      ...payload,
      items: (payload.items ?? []).map(normalizeWorkflowRunRecord)
    })),

  getRun: (runId: string) =>
    fetchJSON<WorkflowRunRecord>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}`).then(
      normalizeWorkflowRunRecord
    ),

  createRun: (data: {
    template_id: string;
    run_id?: string;
    name?: string;
    description?: string;
    workspace_path: string;
    variables?: Record<string, string>;
    task_overrides?: Record<string, string>;
    auto_start?: boolean;
    mode?: WorkflowRunMode;
    loop_enabled?: boolean;
    schedule_enabled?: boolean;
    schedule_expression?: string;
    is_schedule_seed?: boolean;
    auto_dispatch_enabled?: boolean;
    auto_dispatch_remaining?: number;
  }) =>
    fetchJSON<WorkflowRunRecord>(`${API_BASE}/workflow-runs`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  startRun: (runId: string) =>
    fetchJSON<{ runtime: WorkflowRunRuntimeStatus; run: WorkflowRunRecord | null }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/start`,
      {
        method: "POST"
      }
    ).then((payload) => ({
      ...payload,
      run: payload.run ? normalizeWorkflowRunRecord(payload.run) : payload.run
    })),

  stopRun: (runId: string) =>
    fetchJSON<{ runtime: WorkflowRunRuntimeStatus; run: WorkflowRunRecord | null }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/stop`,
      {
        method: "POST"
      }
    ).then((payload) => ({
      ...payload,
      run: payload.run ? normalizeWorkflowRunRecord(payload.run) : payload.run
    })),

  getRunStatus: (runId: string) =>
    fetchJSON<WorkflowRunRuntimeStatus>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/status`),

  getTaskRuntime: (runId: string) =>
    fetchJSON<WorkflowRunRuntimeSnapshot>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/task-runtime`).then(
      normalizeWorkflowRunRuntimeSnapshot
    ),

  getTaskTreeRuntime: (runId: string) =>
    fetchJSON<WorkflowTaskTreeRuntimeResponse>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/task-tree-runtime`
    ).then(normalizeWorkflowTaskTreeRuntimeResponse),

  getTaskTree: (
    runId: string,
    query?: {
      focus_task_id?: string;
      max_descendant_depth?: number;
      include_external_dependencies?: boolean;
    }
  ) => {
    const params = new URLSearchParams();
    if (query?.focus_task_id) params.set("focus_task_id", query.focus_task_id);
    if (typeof query?.max_descendant_depth === "number") {
      params.set("max_descendant_depth", String(query.max_descendant_depth));
    }
    if (typeof query?.include_external_dependencies === "boolean") {
      params.set("include_external_dependencies", query.include_external_dependencies ? "true" : "false");
    }
    const suffix = params.toString();
    return fetchJSON<TaskTreeResponse>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/task-tree${suffix ? `?${suffix}` : ""}`
    ).then(normalizeTaskTreeResponse);
  },

  getTaskDetail: (runId: string, taskId: string) =>
    fetchJSON<TaskDetail>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/detail`
    ).then(normalizeTaskDetail),

  taskAction: (runId: string, data: WorkflowTaskActionRequest) =>
    fetchJSON<WorkflowTaskActionResult>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/task-actions`, {
      method: "POST",
      body: JSON.stringify(data)
    }).then((payload) => ({
      ...payload,
      snapshot: normalizeWorkflowRunRuntimeSnapshot(payload.snapshot)
    })),

  getSessions: (runId: string) =>
    fetchJSON<{ run_id: string; items: Record<string, unknown>[] }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions`
    ).then((payload) => ({
      run_id: payload.run_id,
      items: (payload.items ?? []).map(mapWorkflowSessionFields)
    })),

  getRuntimeRecovery: async (runId: string): Promise<RuntimeRecoveryResponse> =>
    mapRuntimeRecoveryResponse(
      await fetchJSON<Record<string, unknown>>(
        `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/runtime-recovery?attempt_limit=${RECOVERY_CENTER_ATTEMPT_LIMIT}`
      )
    ),

  registerSession: (
    runId: string,
    data: {
      role: string;
      session_id?: string;
      status?: "running" | "idle" | "blocked" | "dismissed";
      provider_id?: "codex" | "minimax";
      provider?: "codex" | "minimax";
      provider_session_id?: string;
    }
  ) =>
    fetchJSON<{ session: Record<string, unknown>; created: boolean }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions`,
      {
        method: "POST",
        body: JSON.stringify(data)
      }
    ).then((payload) => ({
      session: mapWorkflowSessionFields(payload.session),
      created: payload.created
    })),

  dismissSession: (runId: string, sessionId: string, reason?: string, confirm?: boolean) =>
    fetchJSON<{
      action: "dismiss";
      session: Record<string, unknown>;
      previous_status: string;
      next_status: string;
      provider_cancel: Record<string, unknown>;
      process_termination: Record<string, unknown> | null;
      mapping_cleared: boolean;
      warnings: string[];
    }>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(sessionId)}/dismiss`, {
      method: "POST",
      body: JSON.stringify({
        reason: reason ?? "dashboard_manual_dismiss",
        actor: "dashboard",
        ...(confirm ? { confirm: true } : {})
      })
    }).then((payload) => ({
      ...payload,
      session: mapWorkflowSessionFields(payload.session)
    })),

  repairSession: (runId: string, sessionId: string, targetStatus: "idle" | "blocked", confirm?: boolean) =>
    fetchJSON<{
      action: "repair";
      session: Record<string, unknown>;
      previous_status: string;
      next_status: string;
      warnings: string[];
    }>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(sessionId)}/repair`, {
      method: "POST",
      body: JSON.stringify({
        target_status: targetStatus,
        reason: "dashboard_manual_repair",
        actor: "dashboard",
        ...(confirm ? { confirm: true } : {})
      })
    }).then((payload) => ({
      ...payload,
      session: mapWorkflowSessionFields(payload.session)
    })),

  retryDispatchSession: (runId: string, item: RuntimeRecoveryItem, confirm?: boolean) =>
    fetchJSON<Record<string, unknown>>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(item.session_id)}/retry-dispatch`,
      {
        method: "POST",
        body: JSON.stringify(buildRetryDispatchGuardBody(item, "dashboard_manual_retry_dispatch", confirm))
      }
    ),

  sendMessage: (
    runId: string,
    data: {
      from_agent?: string;
      from_session_id?: string;
      to?: { agent?: string; role?: string; session_id?: string };
      to_role?: string;
      to_session_id?: string;
      message_type?: "MANAGER_MESSAGE" | "TASK_DISCUSS_REQUEST" | "TASK_DISCUSS_REPLY" | "TASK_DISCUSS_CLOSED";
      task_id?: string;
      content: string;
      request_id?: string;
      parent_request_id?: string;
      discuss?: { thread_id?: string; request_id?: string };
    }
  ) =>
    fetchJSON<{
      requestId: string;
      messageId: string;
      messageType: string;
      taskId: string | null;
      toRole: string | null;
      resolvedSessionId: string;
      createdAt: string;
    }>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/messages/send`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  getTimeline: async (runId: string, limit = 300): Promise<{ items: AgentIOTimelineItem[]; total: number }> => {
    const data = await fetchJSON<{ items: Record<string, unknown>[]; total: number }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/agent-io/timeline?limit=${encodeURIComponent(String(limit))}`
    );
    return {
      total: data.total ?? 0,
      items: (data.items ?? []).map((raw) => ({
        id: (raw.itemId ?? raw.id) as string,
        projectId: (raw.projectId ?? raw.project_id ?? "") as string,
        sessionId: (raw.sessionId ?? raw.session_id ?? raw.toSessionId ?? "") as string,
        role: (raw.role ?? raw.from ?? raw.originAgent ?? "") as string,
        taskId: (raw.taskId ?? raw.task_id) as string | undefined,
        direction: (raw.direction ?? "inbound") as "inbound" | "outbound",
        messageType: (raw.messageType ?? raw.message_type ?? raw.kind ?? "") as string,
        summary: (raw.content ?? raw.summary) as string | undefined,
        createdAt: (raw.createdAt ?? raw.created_at) as string,
        from: raw.from as string | undefined,
        toRole: (raw.toRole ?? raw.to_role) as string | undefined,
        sourceType: raw.sourceType as "user" | "agent" | "manager" | "system" | undefined,
        originAgent: raw.originAgent as string | undefined,
        kind: raw.kind as string | undefined,
        status: raw.status as string | undefined,
        runId: (raw.runId ?? runId) as string | undefined
      }))
    };
  },

  getOrchestratorSettings: (runId: string) =>
    fetchJSON<WorkflowRunOrchestratorSettings>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/orchestrator/settings`
    ),

  patchOrchestratorSettings: (
    runId: string,
    data: {
      auto_dispatch_enabled?: boolean;
      auto_dispatch_remaining?: number;
      hold_enabled?: boolean;
      reminder_mode?: "backoff" | "fixed_interval";
      mode?: WorkflowRunMode;
      loop_enabled?: boolean;
      schedule_enabled?: boolean;
      schedule_expression?: string | null;
      is_schedule_seed?: boolean;
    }
  ) =>
    fetchJSON<WorkflowRunOrchestratorSettings>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/orchestrator/settings`,
      {
        method: "PATCH",
        body: JSON.stringify(data)
      }
    ),

  dispatch: (runId: string, data: { role?: string; task_id?: string; force?: boolean; only_idle?: boolean } = {}) =>
    fetchJSON<{
      runId: string;
      dispatchedCount: number;
      remainingBudget: number;
      results: Array<{
        role: string;
        sessionId: string | null;
        taskId: string | null;
        dispatchKind?: "task" | "message" | null;
        messageId?: string;
        requestId?: string;
        outcome: "dispatched" | "no_task" | "session_busy" | "run_not_running" | "invalid_target";
        reason?: string;
      }>;
    }>(`${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/orchestrator/dispatch`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  interruptAgentChat: (runId: string, sessionId: string) =>
    fetchJSON<{ success: boolean; cancelled: boolean }>(
      `${API_BASE}/workflow-runs/${encodeURIComponent(runId)}/agent-chat/${encodeURIComponent(sessionId)}/interrupt`,
      { method: "POST" }
    ),

  getOrchestratorStatus: () => fetchJSON<WorkflowOrchestratorStatus>(`${API_BASE}/workflow-orchestrator/status`)
};

export const orchestratorApi = {
  getStatus: () => fetchJSON<OrchestratorStatus>(`${API_BASE}/orchestrator/status`)
};

export const settingsApi = {
  get: () => fetchJSON<RuntimeSettings>(`${API_BASE}/settings`),

  update: (
    data: Omit<Partial<RuntimeSettings>, "minimaxApiKey" | "minimaxApiBase"> & {
      minimaxApiKey?: string | null;
      minimaxApiBase?: string | null;
    }
  ) =>
    fetchJSON<RuntimeSettings>(`${API_BASE}/settings`, {
      method: "PATCH",
      body: JSON.stringify(data)
    })
};

export const modelsApi = {
  list: (projectId?: string, refresh?: boolean) => {
    const params = new URLSearchParams();
    if (projectId) params.set("project_id", projectId);
    if (refresh) params.set("refresh", "true");
    return fetchJSON<{ models: ModelInfo[]; warnings?: string[]; source?: "cache" | "refresh" | "fallback-mixed" }>(
      `${API_BASE}/models?${params.toString()}`
    );
  }
};

export const teamApi = {
  list: () => fetchJSON<{ items: TeamSummary[] }>(`${API_BASE}/teams`),

  get: (teamId: string) => fetchJSON<TeamRecord>(`${API_BASE}/teams/${encodeURIComponent(teamId)}`),

  create: (data: CreateTeamRequest) =>
    fetchJSON<TeamRecord>(`${API_BASE}/teams`, {
      method: "POST",
      body: JSON.stringify(data)
    }),

  update: (teamId: string, data: UpdateTeamRequest) =>
    fetchJSON<TeamRecord>(`${API_BASE}/teams/${encodeURIComponent(teamId)}`, {
      method: "PUT",
      body: JSON.stringify(data)
    }),

  delete: (teamId: string) =>
    fetchJSON<{ removed: boolean }>(`${API_BASE}/teams/${encodeURIComponent(teamId)}`, {
      method: "DELETE"
    })
};
