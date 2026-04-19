import type {
  EventRecord,
  ProjectPaths,
  ProjectRecord,
  SessionRecord,
  TaskRecord,
  WorkflowRunEventRecord,
  WorkflowRunRecord,
  WorkflowSessionRecord,
  WorkflowTaskRuntimeRecord
} from "../domain/models.js";
import { getProjectRepositoryBundle } from "../data/repository/project/repository-bundle.js";
import { listProjectRuntimeEvents } from "./project-runtime-api-service.js";
import { getWorkflowRepositoryBundle } from "../data/repository/workflow/repository-bundle.js";
import { readWorkflowRunTaskRuntimeState } from "../data/repository/workflow/runtime-repository.js";

const RUNNER_FAILURE_EVENT_TYPES = new Set([
  "RUNNER_CONFIG_ERROR_BLOCKED",
  "RUNNER_TRANSIENT_ERROR_SOFT",
  "RUNNER_RUNTIME_ERROR_SOFT",
  "RUNNER_FATAL_ERROR_DISMISSED",
  "RUNNER_TIMEOUT_SOFT",
  "RUNNER_TIMEOUT_ESCALATED"
]);

const RECENT_FAILURE_WINDOW_MS = 30 * 60 * 1000;

type RecoveryStatus = "running" | "idle" | "blocked" | "dismissed";
type FailureKind = "timeout" | "error";
type ScopeKind = "project" | "workflow";

interface RecoveryFailureRecord {
  last_failure_at: string | null;
  last_failure_kind: FailureKind | null;
  retryable: boolean | null;
  code: string | null;
  message: string | null;
  next_action: string | null;
  raw_status: number | string | null;
  last_event_type: string | null;
}

interface RecoverySignalSource {
  status: RecoveryStatus;
  cooldownUntil?: string;
  lastFailureAt?: string;
  lastFailureKind?: FailureKind;
  errorStreak?: number;
  timeoutStreak?: number;
}

export interface RuntimeRecoveryItem {
  role: string;
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  status: RecoveryStatus;
  current_task_id: string | null;
  current_task_title: string | null;
  current_task_state: string | null;
  cooldown_until: string | null;
  last_failure_at: string | null;
  last_failure_kind: FailureKind | null;
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
  scope_kind: ScopeKind;
  scope_id: string;
  generated_at: string;
  summary: RuntimeRecoverySummary;
  items: RuntimeRecoveryItem[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRawStatus(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return readString(value);
}

function buildFailureRecord<
  TEvent extends { eventType: string; createdAt: string; sessionId?: string; payload: Record<string, unknown> }
>(
  session: RecoverySignalSource & {
    sessionId: string;
  },
  events: TEvent[]
): RecoveryFailureRecord {
  const shouldReadHistory =
    Boolean(session.lastFailureAt) ||
    Boolean(session.lastFailureKind) ||
    (session.errorStreak ?? 0) > 0 ||
    (session.timeoutStreak ?? 0) > 0 ||
    Boolean(session.cooldownUntil) ||
    session.status === "blocked" ||
    session.status === "dismissed";
  const latest = shouldReadHistory
    ? [...events]
        .filter((event) => event.sessionId === session.sessionId && RUNNER_FAILURE_EVENT_TYPES.has(event.eventType))
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]
    : undefined;
  const payload = latest ? asRecord(latest.payload) : {};
  const fallbackKind = latest?.eventType?.startsWith("RUNNER_TIMEOUT_") ? "timeout" : latest ? "error" : null;
  return {
    last_failure_at: session.lastFailureAt ?? latest?.createdAt ?? null,
    last_failure_kind: session.lastFailureKind ?? fallbackKind,
    retryable: typeof payload.retryable === "boolean" ? payload.retryable : null,
    code: readString(payload.code),
    message: readString(payload.error ?? payload.message),
    next_action: readString(payload.next_action),
    raw_status: readRawStatus(payload.raw_status),
    last_event_type: latest?.eventType ?? null
  };
}

function buildActionability(status: RecoveryStatus) {
  return {
    can_dismiss: status !== "dismissed",
    can_repair_to_idle: status !== "idle",
    can_repair_to_blocked: status !== "blocked"
  };
}

function isRecoveryCandidate(item: RuntimeRecoveryItem, nowMs: number): boolean {
  return (
    item.status === "blocked" ||
    item.status === "dismissed" ||
    isCoolingDown(item.cooldown_until, nowMs) ||
    isFailureRecent(item.last_failure_at, nowMs) ||
    item.retryable === true ||
    item.error_streak > 0 ||
    item.timeout_streak > 0 ||
    item.code !== null
  );
}

function isCoolingDown(cooldownUntil: string | null, nowMs: number): boolean {
  if (!cooldownUntil) {
    return false;
  }
  const ts = Date.parse(cooldownUntil);
  return Number.isFinite(ts) && ts > nowMs;
}

function isFailureRecent(lastFailureAt: string | null, nowMs: number): boolean {
  if (!lastFailureAt) {
    return false;
  }
  const ts = Date.parse(lastFailureAt);
  return Number.isFinite(ts) && nowMs - ts <= RECENT_FAILURE_WINDOW_MS;
}

function summarizeItems(items: RuntimeRecoveryItem[], nowMs: number): RuntimeRecoverySummary {
  return items.reduce<RuntimeRecoverySummary>(
    (summary, item) => {
      summary.total += 1;
      if (item.status === "running") summary.running += 1;
      if (item.status === "blocked") summary.blocked += 1;
      if (item.status === "idle") summary.idle += 1;
      if (item.status === "dismissed") summary.dismissed += 1;
      if (isCoolingDown(item.cooldown_until, nowMs)) summary.cooling_down += 1;
      if (isFailureRecent(item.last_failure_at, nowMs)) summary.failed_recently += 1;
      return summary;
    },
    {
      total: 0,
      running: 0,
      blocked: 0,
      idle: 0,
      dismissed: 0,
      cooling_down: 0,
      failed_recently: 0
    }
  );
}

function buildProjectRecoveryItem(
  session: SessionRecord,
  tasksById: Map<string, TaskRecord>,
  events: EventRecord[]
): RuntimeRecoveryItem {
  const currentTask = session.currentTaskId ? (tasksById.get(session.currentTaskId) ?? null) : null;
  const failure = buildFailureRecord(session, events);
  return {
    role: session.role,
    session_id: session.sessionId,
    provider: session.provider,
    provider_session_id: session.providerSessionId ?? null,
    status: session.status,
    current_task_id: session.currentTaskId ?? null,
    current_task_title: currentTask?.title ?? null,
    current_task_state: currentTask?.state ?? null,
    cooldown_until: session.cooldownUntil ?? null,
    last_failure_at: failure.last_failure_at,
    last_failure_kind: failure.last_failure_kind,
    error_streak: session.errorStreak ?? 0,
    timeout_streak: session.timeoutStreak ?? 0,
    retryable: failure.retryable,
    code: failure.code,
    message: failure.message,
    next_action: failure.next_action,
    raw_status: failure.raw_status,
    last_event_type: failure.last_event_type,
    ...buildActionability(session.status)
  };
}

function buildWorkflowRecoveryItem(
  session: WorkflowSessionRecord,
  run: WorkflowRunRecord,
  runtimeTasksById: Map<string, WorkflowTaskRuntimeRecord>,
  events: WorkflowRunEventRecord[]
): RuntimeRecoveryItem {
  const taskTemplate = session.currentTaskId
    ? (run.tasks.find((task) => task.taskId === session.currentTaskId) ?? null)
    : null;
  const runtimeTask = session.currentTaskId ? (runtimeTasksById.get(session.currentTaskId) ?? null) : null;
  const failure = buildFailureRecord(session, events);
  return {
    role: session.role,
    session_id: session.sessionId,
    provider: session.provider,
    provider_session_id: session.providerSessionId ?? null,
    status: session.status,
    current_task_id: session.currentTaskId ?? null,
    current_task_title: taskTemplate?.resolvedTitle ?? taskTemplate?.title ?? null,
    current_task_state: runtimeTask?.state ?? null,
    cooldown_until: session.cooldownUntil ?? null,
    last_failure_at: failure.last_failure_at,
    last_failure_kind: failure.last_failure_kind,
    error_streak: session.errorStreak ?? 0,
    timeout_streak: session.timeoutStreak ?? 0,
    retryable: failure.retryable,
    code: failure.code,
    message: failure.message,
    next_action: failure.next_action,
    raw_status: failure.raw_status,
    last_event_type: failure.last_event_type,
    ...buildActionability(session.status)
  };
}

export async function buildProjectRuntimeRecovery(
  dataRoot: string,
  projectId: string
): Promise<RuntimeRecoveryResponse> {
  const repositories = getProjectRepositoryBundle(dataRoot);
  const scope = await repositories.resolveScope(projectId);
  const [sessions, tasks, events] = await Promise.all([
    repositories.sessions.listSessions(scope.paths, scope.project.projectId),
    repositories.taskboard.listTasks(scope.paths, scope.project.projectId),
    listProjectRuntimeEvents(dataRoot, projectId)
  ]);
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const nowMs = Date.now();
  const items = sessions
    .map((session) => buildProjectRecoveryItem(session, tasksById, events))
    .filter((item) => isRecoveryCandidate(item, nowMs))
    .sort((left, right) => left.role.localeCompare(right.role) || left.session_id.localeCompare(right.session_id));
  return {
    scope_kind: "project",
    scope_id: scope.project.projectId,
    generated_at: new Date(nowMs).toISOString(),
    summary: summarizeItems(items, nowMs),
    items
  };
}

export async function buildWorkflowRuntimeRecovery(dataRoot: string, runId: string): Promise<RuntimeRecoveryResponse> {
  const repositories = getWorkflowRepositoryBundle(dataRoot);
  const scope = await repositories.resolveScope(runId);
  const [sessions, events, runtime] = await Promise.all([
    repositories.sessions.listSessions(scope.run.runId),
    repositories.events.listEvents(scope.run.runId),
    readWorkflowRunTaskRuntimeState(dataRoot, scope.run.runId)
  ]);
  const runtimeTasksById = new Map(runtime.tasks.map((task) => [task.taskId, task]));
  const nowMs = Date.now();
  const items = sessions
    .map((session) => buildWorkflowRecoveryItem(session, scope.run, runtimeTasksById, events))
    .filter((item) => isRecoveryCandidate(item, nowMs))
    .sort((left, right) => left.role.localeCompare(right.role) || left.session_id.localeCompare(right.session_id));
  return {
    scope_kind: "workflow",
    scope_id: scope.run.runId,
    generated_at: new Date(nowMs).toISOString(),
    summary: summarizeItems(items, nowMs),
    items
  };
}
