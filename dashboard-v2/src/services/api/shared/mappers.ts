import type {
  EventRecord,
  RuntimeRecoveryAttempt,
  RuntimeRecoveryAttemptPreview,
  RuntimeRecoveryAttemptsResponse,
  RuntimeRecoveryItem,
  RuntimeRecoveryResponse,
  RuntimeRecoverySummary,
  SessionRecord,
  SkillDefinition,
  SkillListDefinition,
  TaskDetail,
  TaskTreeNode,
  TaskTreeResponse,
  WorkflowRunRecord,
  WorkflowRunRuntimeCounters,
  WorkflowRunRuntimeSnapshot,
  WorkflowSessionRecord,
  WorkflowTaskRuntimeRecord,
  WorkflowTaskTransitionRecord,
  WorkflowTaskTreeRuntimeNode,
  WorkflowTaskTreeRuntimeResponse
} from "@/types";
import type { ProviderId } from "@autodev/agent-library";

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

export function normalizeTaskTreeNode(node: TaskTreeNode): TaskTreeNode {
  return {
    ...node,
    state: normalizeTaskState(node.state)
  };
}

export function normalizeTaskTreeResponse(response: TaskTreeResponse): TaskTreeResponse {
  return {
    ...response,
    focus: response.focus ? normalizeTaskTreeNode(response.focus) : null,
    nodes: (response.nodes ?? []).map(normalizeTaskTreeNode)
  };
}

export function normalizeTaskDetail(detail: TaskDetail): TaskDetail {
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

export function normalizeWorkflowRunRuntimeCounters(counters: WorkflowRunRuntimeCounters): WorkflowRunRuntimeCounters {
  return counters;
}

export function normalizeWorkflowRunRuntimeSnapshot(snapshot: WorkflowRunRuntimeSnapshot): WorkflowRunRuntimeSnapshot {
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

export function normalizeWorkflowTaskTreeRuntimeResponse(
  response: WorkflowTaskTreeRuntimeResponse
): WorkflowTaskTreeRuntimeResponse {
  return {
    ...response,
    counters: normalizeWorkflowRunRuntimeCounters(response.counters),
    nodes: (response.nodes ?? []).map(normalizeWorkflowTaskTreeRuntimeNode)
  };
}

export function normalizeWorkflowRunRecord(run: WorkflowRunRecord): WorkflowRunRecord {
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

export function mapSessionFields(raw: Record<string, unknown>): SessionRecord {
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

export function mapEventFields(raw: Record<string, unknown>): EventRecord {
  return {
    eventId: (raw.eventId ?? raw.event_id) as string,
    eventType: (raw.eventType ?? raw.event_type) as string,
    source: raw.source as string,
    createdAt: (raw.createdAt ?? raw.created_at) as string,
    sessionId: (raw.sessionId ?? raw.session_id) as string | undefined,
    payload: (raw.payload ?? {}) as Record<string, unknown>
  };
}

export function mapSkillDefinition(raw: Record<string, unknown>): SkillDefinition {
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

export function mapSkillListDefinition(raw: Record<string, unknown>): SkillListDefinition {
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

export function mapWorkflowSessionFields(raw: Record<string, unknown>): WorkflowSessionRecord {
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
      ? raw.recovery_attempts.map((attempt) => mapRuntimeRecoveryAttemptPreview(attempt as Record<string, unknown>))
      : []
  };
}

export function mapRuntimeRecoveryAttemptPreview(raw: Record<string, unknown>): RuntimeRecoveryAttemptPreview {
  return {
    recovery_attempt_id: String(raw.recovery_attempt_id ?? ""),
    status: (raw.status as RuntimeRecoveryAttemptPreview["status"] | undefined) ?? "requested",
    integrity: (raw.integrity as RuntimeRecoveryAttemptPreview["integrity"] | undefined) ?? "incomplete",
    missing_markers: Array.isArray(raw.missing_markers)
      ? raw.missing_markers
          .filter((marker): marker is string => typeof marker === "string")
          .map((marker) => marker as RuntimeRecoveryAttemptPreview["missing_markers"][number])
      : [],
    requested_at: (raw.requested_at as string | null | undefined) ?? null,
    last_event_at: String(raw.last_event_at ?? ""),
    ended_at: (raw.ended_at as string | null | undefined) ?? null,
    dispatch_scope: (raw.dispatch_scope as RuntimeRecoveryAttemptPreview["dispatch_scope"] | undefined) ?? null,
    current_task_id: (raw.current_task_id as string | null | undefined) ?? null
  };
}

export function mapRuntimeRecoveryAttempt(raw: Record<string, unknown>): RuntimeRecoveryAttempt {
  return {
    ...mapRuntimeRecoveryAttemptPreview(raw),
    events: Array.isArray(raw.events)
      ? raw.events.map((event) => ({
          event_type: String((event as Record<string, unknown>).event_type ?? ""),
          created_at: String((event as Record<string, unknown>).created_at ?? ""),
          payload_summary: String((event as Record<string, unknown>).payload_summary ?? "")
        }))
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

export function mapRuntimeRecoveryResponse(raw: Record<string, unknown>): RuntimeRecoveryResponse {
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

export function mapRuntimeRecoveryAttemptsResponse(raw: Record<string, unknown>): RuntimeRecoveryAttemptsResponse {
  return {
    scope_kind: raw.scope_kind as RuntimeRecoveryAttemptsResponse["scope_kind"],
    scope_id: String(raw.scope_id ?? ""),
    session_id: String(raw.session_id ?? ""),
    generated_at: String(raw.generated_at ?? ""),
    attempt_limit:
      raw.attempt_limit === "all" ? "all" : Number.isFinite(Number(raw.attempt_limit)) ? Number(raw.attempt_limit) : 0,
    total_attempts: Number(raw.total_attempts ?? 0),
    truncated: Boolean(raw.truncated),
    recovery_attempts: Array.isArray(raw.recovery_attempts)
      ? raw.recovery_attempts.map((attempt) => mapRuntimeRecoveryAttempt(attempt as Record<string, unknown>))
      : []
  };
}

export function buildRetryDispatchGuardBody(
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
