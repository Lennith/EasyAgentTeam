import type {
  EventRecord,
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
import {
  type RecoveryFailureKind,
  type RecoveryScopeKind,
  type RecoveryStatus
} from "./runtime-recovery-action-policy.js";
import { buildRecoveryPolicyContext } from "./runtime-recovery-policy-context.js";

const RUNNER_FAILURE_EVENT_TYPES = new Set([
  "RUNNER_CONFIG_ERROR_BLOCKED",
  "RUNNER_TRANSIENT_ERROR_SOFT",
  "RUNNER_RUNTIME_ERROR_SOFT",
  "RUNNER_FATAL_ERROR_DISMISSED",
  "RUNNER_TIMEOUT_SOFT",
  "RUNNER_TIMEOUT_ESCALATED"
]);

const RECOVERY_AUDIT_EVENT_TYPES = new Set([
  ...RUNNER_FAILURE_EVENT_TYPES,
  "SESSION_DISMISS_EXTERNAL_RESULT",
  "SESSION_STATUS_REPAIRED",
  "SESSION_STATUS_DISMISSED",
  "SESSION_RETRY_DISPATCH_REQUESTED",
  "SESSION_RETRY_DISPATCH_ACCEPTED",
  "SESSION_RETRY_DISPATCH_REJECTED"
]);
const RECOVERY_ATTEMPT_EVENT_TYPES = new Set([
  "SESSION_RETRY_DISPATCH_REQUESTED",
  "SESSION_RETRY_DISPATCH_ACCEPTED",
  "SESSION_RETRY_DISPATCH_REJECTED",
  "ORCHESTRATOR_DISPATCH_STARTED",
  "ORCHESTRATOR_DISPATCH_FINISHED",
  "ORCHESTRATOR_DISPATCH_FAILED"
]);
const RECOVERY_ATTEMPT_TERMINAL_EVENT_TYPES = new Set([
  "SESSION_RETRY_DISPATCH_REJECTED",
  "ORCHESTRATOR_DISPATCH_FINISHED",
  "ORCHESTRATOR_DISPATCH_FAILED"
]);

const RECENT_FAILURE_WINDOW_MS = 30 * 60 * 1000;
const RECOVERY_EVENT_SUMMARY_LIMIT = 4;

interface RecoveryFailureRecord {
  last_failure_at: string | null;
  last_failure_kind: RecoveryFailureKind | null;
  last_failure_event_id: string | null;
  last_failure_dispatch_id: string | null;
  last_failure_message_id: string | null;
  last_failure_task_id: string | null;
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
  lastFailureKind?: RecoveryFailureKind;
  lastFailureEventId?: string;
  lastFailureDispatchId?: string;
  lastFailureMessageId?: string;
  lastFailureTaskId?: string;
  errorStreak?: number;
  timeoutStreak?: number;
}

export interface RuntimeRecoveryEventSummary {
  event_type: string;
  created_at: string;
  payload_summary: string;
}

export type RuntimeRecoveryAttemptStatus = "requested" | "accepted" | "running" | "finished" | "failed" | "rejected";
export type RuntimeRecoveryAttemptIntegrity = "complete" | "incomplete";
export type RuntimeRecoveryAttemptMissingMarker =
  | "requested"
  | "accepted_or_rejected"
  | "dispatch_started"
  | "dispatch_terminal";

export interface RuntimeRecoveryAttempt {
  recovery_attempt_id: string;
  status: RuntimeRecoveryAttemptStatus;
  integrity: RuntimeRecoveryAttemptIntegrity;
  missing_markers: RuntimeRecoveryAttemptMissingMarker[];
  requested_at: string | null;
  last_event_at: string;
  ended_at: string | null;
  dispatch_scope: "task" | "role" | null;
  current_task_id: string | null;
  events: RuntimeRecoveryEventSummary[];
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
  role_session_mapping: "authoritative" | "stale" | "none";
  cooldown_until: string | null;
  last_failure_at: string | null;
  last_failure_kind: RecoveryFailureKind | null;
  last_failure_event_id: string | null;
  last_failure_dispatch_id: string | null;
  last_failure_message_id: string | null;
  last_failure_task_id: string | null;
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
  can_retry_dispatch: boolean;
  disabled_reason: string | null;
  risk: string | null;
  requires_confirmation: boolean;
  latest_events: RuntimeRecoveryEventSummary[];
  recovery_attempts: RuntimeRecoveryAttempt[];
}

export interface RuntimeRecoverySummary {
  all_sessions_total: number;
  recovery_candidates_total: number;
  running: number;
  blocked: number;
  idle: number;
  dismissed: number;
  cooling_down: number;
  failed_recently: number;
}

export interface RuntimeRecoveryResponse {
  scope_kind: RecoveryScopeKind;
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

function compareEventsAsc<TEvent extends { createdAt: string; eventId: string }>(left: TEvent, right: TEvent): number {
  const timeDiff = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return left.eventId.localeCompare(right.eventId);
}

function compareEventsDesc<TEvent extends { createdAt: string; eventId: string }>(left: TEvent, right: TEvent): number {
  return compareEventsAsc(right, left);
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

function indexLatestFailureEvents<
  TEvent extends {
    eventId: string;
    eventType: string;
    createdAt: string;
    sessionId?: string;
    payload: Record<string, unknown>;
  }
>(events: readonly TEvent[]): Map<string, TEvent> {
  const latestBySession = new Map<string, TEvent>();
  for (const event of events) {
    if (!event.sessionId || !RUNNER_FAILURE_EVENT_TYPES.has(event.eventType)) {
      continue;
    }
    const existing = latestBySession.get(event.sessionId);
    if (!existing || Date.parse(event.createdAt) > Date.parse(existing.createdAt)) {
      latestBySession.set(event.sessionId, event);
    }
  }
  return latestBySession;
}

function readDispatchKind(payload: Record<string, unknown>): string | null {
  return readString(payload.dispatchKind ?? payload.dispatch_kind ?? asRecord(payload.options).dispatchKind);
}

function readRecoveryAttemptId(payload: Record<string, unknown>): string | null {
  return readString(payload.recovery_attempt_id ?? asRecord(payload.extra).recovery_attempt_id);
}

function normalizeDispatchScope(value: string | null, taskId: string | null): "task" | "role" | null {
  if (value === "task") {
    return "task";
  }
  if (value === "role" || value === "message") {
    return "role";
  }
  if (taskId) {
    return "task";
  }
  return null;
}

function summarizeRecoveryEventPayload(
  eventType: string,
  payload: Record<string, unknown>,
  taskId: string | null = null
): string {
  if (RUNNER_FAILURE_EVENT_TYPES.has(eventType)) {
    const code = readString(payload.code);
    const message = readString(payload.error ?? payload.message);
    return [code, message].filter(Boolean).join(": ") || eventType;
  }
  if (eventType === "SESSION_STATUS_REPAIRED") {
    const previousStatus = readString(payload.previous_status) ?? "unknown";
    const targetStatus = readString(payload.target_status) ?? "unknown";
    return `${previousStatus} -> ${targetStatus}`;
  }
  if (eventType === "SESSION_RETRY_DISPATCH_REQUESTED") {
    const dispatchScope = readString(payload.dispatch_scope) ?? "role";
    return `retry requested (${dispatchScope})`;
  }
  if (eventType === "SESSION_RETRY_DISPATCH_ACCEPTED") {
    const dispatchScope = readString(payload.dispatch_scope) ?? "role";
    return `retry accepted (${dispatchScope})`;
  }
  if (eventType === "SESSION_RETRY_DISPATCH_REJECTED") {
    const dispatchScope = readString(payload.dispatch_scope) ?? "role";
    return `retry rejected (${dispatchScope})`;
  }
  if (eventType === "ORCHESTRATOR_DISPATCH_STARTED") {
    const dispatchScope = normalizeDispatchScope(readDispatchKind(payload), taskId) ?? "role";
    return `dispatch started (${dispatchScope})`;
  }
  if (eventType === "ORCHESTRATOR_DISPATCH_FINISHED") {
    const dispatchScope = normalizeDispatchScope(readDispatchKind(payload), taskId) ?? "role";
    return `dispatch finished (${dispatchScope})`;
  }
  if (eventType === "ORCHESTRATOR_DISPATCH_FAILED") {
    const dispatchScope = normalizeDispatchScope(readDispatchKind(payload), taskId) ?? "role";
    const error = readString(payload.error);
    return [`dispatch failed (${dispatchScope})`, error].filter(Boolean).join(": ");
  }
  if (eventType === "SESSION_DISMISS_EXTERNAL_RESULT") {
    const providerCancel = asRecord(payload.provider_cancel);
    const processTermination = asRecord(payload.process_termination);
    const providerResult = readString(providerCancel.result);
    const processResult = readString(processTermination.result);
    return [providerResult, processResult].filter(Boolean).join(" / ") || eventType;
  }
  if (eventType === "SESSION_STATUS_DISMISSED") {
    const reason = readString(payload.reason) ?? "manual dismiss";
    return reason;
  }
  return eventType;
}

function indexRecoveryAuditEvents<
  TEvent extends {
    eventId: string;
    eventType: string;
    createdAt: string;
    sessionId?: string;
    taskId?: string;
    payload: Record<string, unknown>;
  }
>(events: readonly TEvent[]): Map<string, RuntimeRecoveryEventSummary[]> {
  const bySession = new Map<string, RuntimeRecoveryEventSummary[]>();
  const sorted = [...events]
    .filter((event) => event.sessionId && RECOVERY_AUDIT_EVENT_TYPES.has(event.eventType))
    .sort(compareEventsDesc);
  for (const event of sorted) {
    const sessionId = event.sessionId!;
    const existing = bySession.get(sessionId) ?? [];
    if (existing.length >= RECOVERY_EVENT_SUMMARY_LIMIT) {
      continue;
    }
    existing.push({
      event_type: event.eventType,
      created_at: event.createdAt,
      payload_summary: summarizeRecoveryEventPayload(event.eventType, asRecord(event.payload), event.taskId ?? null)
    });
    bySession.set(sessionId, existing);
  }
  return bySession;
}

function buildRecoveryAttemptEventSummary<
  TEvent extends {
    eventType: string;
    createdAt: string;
    taskId?: string;
    payload: Record<string, unknown>;
  }
>(event: TEvent): RuntimeRecoveryEventSummary {
  return {
    event_type: event.eventType,
    created_at: event.createdAt,
    payload_summary: summarizeRecoveryEventPayload(event.eventType, asRecord(event.payload), event.taskId ?? null)
  };
}

function resolveAttemptDispatchScope<
  TEvent extends {
    taskId?: string;
    payload: Record<string, unknown>;
  }
>(events: readonly TEvent[]): "task" | "role" | null {
  for (const event of events) {
    const payload = asRecord(event.payload);
    const direct = normalizeDispatchScope(readString(payload.dispatch_scope), event.taskId ?? null);
    if (direct) {
      return direct;
    }
    const derived = normalizeDispatchScope(readDispatchKind(payload), event.taskId ?? null);
    if (derived) {
      return derived;
    }
  }
  return null;
}

function resolveAttemptCurrentTaskId<
  TEvent extends {
    taskId?: string;
    payload: Record<string, unknown>;
  }
>(events: readonly TEvent[]): string | null {
  for (const event of events) {
    const payload = asRecord(event.payload);
    const fromPayload = readString(payload.current_task_id ?? payload.currentTaskId ?? payload.task_id);
    if (fromPayload) {
      return fromPayload;
    }
    if (event.taskId) {
      return event.taskId;
    }
  }
  return null;
}

function buildRecoveryAttemptStatus<
  TEvent extends {
    eventType: string;
  }
>(events: readonly TEvent[]): RuntimeRecoveryAttemptStatus {
  const eventTypes = new Set(events.map((event) => event.eventType));
  if (eventTypes.has("SESSION_RETRY_DISPATCH_REJECTED")) {
    return "rejected";
  }
  if (eventTypes.has("ORCHESTRATOR_DISPATCH_FAILED")) {
    return "failed";
  }
  if (eventTypes.has("ORCHESTRATOR_DISPATCH_FINISHED")) {
    return "finished";
  }
  if (eventTypes.has("ORCHESTRATOR_DISPATCH_STARTED")) {
    return "running";
  }
  if (eventTypes.has("SESSION_RETRY_DISPATCH_ACCEPTED")) {
    return "accepted";
  }
  return "requested";
}

function buildRecoveryAttemptMissingMarkers<
  TEvent extends {
    eventType: string;
  }
>(
  events: readonly TEvent[],
  sessionStatus: RecoveryStatus,
  isLatestAttempt: boolean
): RuntimeRecoveryAttemptMissingMarker[] {
  const eventTypes = new Set(events.map((event) => event.eventType));
  const hasRequested = eventTypes.has("SESSION_RETRY_DISPATCH_REQUESTED");
  const hasAccepted = eventTypes.has("SESSION_RETRY_DISPATCH_ACCEPTED");
  const hasRejected = eventTypes.has("SESSION_RETRY_DISPATCH_REJECTED");
  const hasDecision = hasAccepted || hasRejected;
  const hasDispatchStarted = eventTypes.has("ORCHESTRATOR_DISPATCH_STARTED");
  const hasDispatchTerminal =
    eventTypes.has("ORCHESTRATOR_DISPATCH_FINISHED") || eventTypes.has("ORCHESTRATOR_DISPATCH_FAILED");
  const isInflight =
    hasAccepted &&
    hasDispatchStarted &&
    !hasDispatchTerminal &&
    !hasRejected &&
    isLatestAttempt &&
    sessionStatus === "running";
  const missing = new Set<RuntimeRecoveryAttemptMissingMarker>();

  if (!hasRequested) {
    missing.add("requested");
  }
  if (!hasDecision) {
    missing.add("accepted_or_rejected");
  }
  if (!hasRejected && (hasAccepted || hasDispatchStarted || hasDispatchTerminal) && !hasDispatchStarted) {
    missing.add("dispatch_started");
  }
  if (!hasRejected && hasDispatchStarted && !hasDispatchTerminal && !isInflight) {
    missing.add("dispatch_terminal");
  }

  return [...missing];
}

function buildRecoveryAttempt<
  TEvent extends {
    eventId: string;
    eventType: string;
    createdAt: string;
    taskId?: string;
    payload: Record<string, unknown>;
  }
>(
  recoveryAttemptId: string,
  rawEvents: readonly TEvent[],
  sessionStatus: RecoveryStatus,
  isLatestAttempt: boolean
): RuntimeRecoveryAttempt {
  const events = [...rawEvents].sort(compareEventsAsc);
  const status = buildRecoveryAttemptStatus(events);
  const missingMarkers = buildRecoveryAttemptMissingMarkers(events, sessionStatus, isLatestAttempt);
  const requestedAt = events.find((event) => event.eventType === "SESSION_RETRY_DISPATCH_REQUESTED")?.createdAt ?? null;
  const endedAt =
    status === "rejected" || status === "failed" || status === "finished"
      ? ([...events].reverse().find((event) => RECOVERY_ATTEMPT_TERMINAL_EVENT_TYPES.has(event.eventType))?.createdAt ??
        null)
      : null;
  const lastEventAt = events[events.length - 1]!.createdAt;

  return {
    recovery_attempt_id: recoveryAttemptId,
    status,
    integrity: missingMarkers.length === 0 ? "complete" : "incomplete",
    missing_markers: missingMarkers,
    requested_at: requestedAt,
    last_event_at: lastEventAt,
    ended_at: endedAt,
    dispatch_scope: resolveAttemptDispatchScope(events),
    current_task_id: resolveAttemptCurrentTaskId(events),
    events: events.map((event) => buildRecoveryAttemptEventSummary(event))
  };
}

function indexRecoveryAttempts<
  TEvent extends {
    eventId: string;
    eventType: string;
    createdAt: string;
    sessionId?: string;
    taskId?: string;
    payload: Record<string, unknown>;
  }
>(
  events: readonly TEvent[],
  sessionStatuses: ReadonlyMap<string, RecoveryStatus>
): Map<string, RuntimeRecoveryAttempt[]> {
  const attemptsBySession = new Map<string, Map<string, TEvent[]>>();

  for (const event of events) {
    if (!event.sessionId || !RECOVERY_ATTEMPT_EVENT_TYPES.has(event.eventType)) {
      continue;
    }
    const payload = asRecord(event.payload);
    const recoveryAttemptId = readRecoveryAttemptId(payload);
    if (!recoveryAttemptId) {
      continue;
    }
    const sessionAttempts = attemptsBySession.get(event.sessionId) ?? new Map<string, TEvent[]>();
    const attemptEvents = sessionAttempts.get(recoveryAttemptId) ?? [];
    attemptEvents.push(event);
    sessionAttempts.set(recoveryAttemptId, attemptEvents);
    attemptsBySession.set(event.sessionId, sessionAttempts);
  }

  const result = new Map<string, RuntimeRecoveryAttempt[]>();
  for (const [sessionId, attempts] of attemptsBySession.entries()) {
    const sortedAttempts = [...attempts.entries()]
      .map(([recoveryAttemptId, attemptEvents]) => ({
        recoveryAttemptId,
        attemptEvents: [...attemptEvents].sort(compareEventsAsc)
      }))
      .sort((left, right) => {
        const leftLast = left.attemptEvents[left.attemptEvents.length - 1]!;
        const rightLast = right.attemptEvents[right.attemptEvents.length - 1]!;
        return compareEventsDesc(leftLast, rightLast);
      })
      .map((attempt, index) =>
        buildRecoveryAttempt(
          attempt.recoveryAttemptId,
          attempt.attemptEvents,
          sessionStatuses.get(sessionId) ?? "idle",
          index === 0
        )
      );
    result.set(sessionId, sortedAttempts);
  }
  return result;
}

function buildFailureRecord<TEvent extends { eventType: string; createdAt: string; payload: Record<string, unknown> }>(
  session: RecoverySignalSource,
  latestFailureEvent: TEvent | undefined
): RecoveryFailureRecord {
  const shouldReadHistory =
    Boolean(session.lastFailureAt) ||
    Boolean(session.lastFailureKind) ||
    (session.errorStreak ?? 0) > 0 ||
    (session.timeoutStreak ?? 0) > 0 ||
    Boolean(session.cooldownUntil) ||
    session.status === "blocked" ||
    session.status === "dismissed";
  const latest = shouldReadHistory ? latestFailureEvent : undefined;
  const payload = latest ? asRecord(latest.payload) : {};
  const fallbackKind = latest?.eventType?.startsWith("RUNNER_TIMEOUT_") ? "timeout" : latest ? "error" : null;
  return {
    last_failure_at: session.lastFailureAt ?? latest?.createdAt ?? null,
    last_failure_kind: session.lastFailureKind ?? fallbackKind,
    last_failure_event_id: session.lastFailureEventId ?? null,
    last_failure_dispatch_id: session.lastFailureDispatchId ?? null,
    last_failure_message_id: session.lastFailureMessageId ?? null,
    last_failure_task_id: session.lastFailureTaskId ?? null,
    retryable: typeof payload.retryable === "boolean" ? payload.retryable : null,
    code: readString(payload.code),
    message: readString(payload.error ?? payload.message),
    next_action: readString(payload.next_action),
    raw_status: readRawStatus(payload.raw_status),
    last_event_type: latest?.eventType ?? null
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

function summarizeItems(items: RuntimeRecoveryItem[], allSessionsTotal: number, nowMs: number): RuntimeRecoverySummary {
  return items.reduce<RuntimeRecoverySummary>(
    (summary, item) => {
      summary.recovery_candidates_total += 1;
      if (item.status === "running") summary.running += 1;
      if (item.status === "blocked") summary.blocked += 1;
      if (item.status === "idle") summary.idle += 1;
      if (item.status === "dismissed") summary.dismissed += 1;
      if (isCoolingDown(item.cooldown_until, nowMs)) summary.cooling_down += 1;
      if (isFailureRecent(item.last_failure_at, nowMs)) summary.failed_recently += 1;
      return summary;
    },
    {
      all_sessions_total: allSessionsTotal,
      recovery_candidates_total: 0,
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
  project: ProjectRecord,
  tasksById: Map<string, TaskRecord>,
  latestFailureBySession: Map<string, EventRecord>,
  latestAuditBySession: Map<string, RuntimeRecoveryEventSummary[]>,
  attemptsBySession: Map<string, RuntimeRecoveryAttempt[]>
): RuntimeRecoveryItem {
  const currentTask = session.currentTaskId ? (tasksById.get(session.currentTaskId) ?? null) : null;
  const failure = buildFailureRecord(session, latestFailureBySession.get(session.sessionId));
  const contextResult = buildRecoveryPolicyContext({
    scope_kind: "project",
    session,
    role_session_map: project.roleSessionMap,
    last_failure_kind: failure.last_failure_kind,
    provider_session_id: session.providerSessionId ?? null
  });
  const { policy } = contextResult;
  return {
    role: session.role,
    session_id: session.sessionId,
    provider: session.provider,
    provider_session_id: session.providerSessionId ?? null,
    status: session.status,
    current_task_id: session.currentTaskId ?? null,
    current_task_title: currentTask?.title ?? null,
    current_task_state: currentTask?.state ?? null,
    role_session_mapping: contextResult.input.role_session_mapping ?? "none",
    cooldown_until: session.cooldownUntil ?? null,
    last_failure_at: failure.last_failure_at,
    last_failure_kind: failure.last_failure_kind,
    last_failure_event_id: failure.last_failure_event_id,
    last_failure_dispatch_id: failure.last_failure_dispatch_id,
    last_failure_message_id: failure.last_failure_message_id,
    last_failure_task_id: failure.last_failure_task_id,
    error_streak: session.errorStreak ?? 0,
    timeout_streak: session.timeoutStreak ?? 0,
    retryable: failure.retryable,
    code: failure.code,
    message: failure.message,
    next_action: failure.next_action,
    raw_status: failure.raw_status,
    last_event_type: failure.last_event_type,
    can_dismiss: policy.can_dismiss,
    can_repair_to_idle: policy.can_repair_to_idle,
    can_repair_to_blocked: policy.can_repair_to_blocked,
    can_retry_dispatch: policy.can_retry_dispatch,
    disabled_reason: policy.disabled_reason,
    risk: policy.risk,
    requires_confirmation: policy.requires_confirmation,
    latest_events: latestAuditBySession.get(session.sessionId) ?? [],
    recovery_attempts: attemptsBySession.get(session.sessionId) ?? []
  };
}

function buildWorkflowRecoveryItem(
  session: WorkflowSessionRecord,
  run: WorkflowRunRecord,
  runtimeTasksById: Map<string, WorkflowTaskRuntimeRecord>,
  latestFailureBySession: Map<string, WorkflowRunEventRecord>,
  latestAuditBySession: Map<string, RuntimeRecoveryEventSummary[]>,
  attemptsBySession: Map<string, RuntimeRecoveryAttempt[]>
): RuntimeRecoveryItem {
  const taskTemplate = session.currentTaskId
    ? (run.tasks.find((task) => task.taskId === session.currentTaskId) ?? null)
    : null;
  const runtimeTask = session.currentTaskId ? (runtimeTasksById.get(session.currentTaskId) ?? null) : null;
  const failure = buildFailureRecord(session, latestFailureBySession.get(session.sessionId));
  const contextResult = buildRecoveryPolicyContext({
    scope_kind: "workflow",
    session,
    role_session_map: run.roleSessionMap,
    last_failure_kind: failure.last_failure_kind,
    provider_session_id: session.providerSessionId ?? null
  });
  const { policy } = contextResult;
  return {
    role: session.role,
    session_id: session.sessionId,
    provider: session.provider,
    provider_session_id: session.providerSessionId ?? null,
    status: session.status,
    current_task_id: session.currentTaskId ?? null,
    current_task_title: taskTemplate?.resolvedTitle ?? taskTemplate?.title ?? null,
    current_task_state: runtimeTask?.state ?? null,
    role_session_mapping: contextResult.input.role_session_mapping ?? "none",
    cooldown_until: session.cooldownUntil ?? null,
    last_failure_at: failure.last_failure_at,
    last_failure_kind: failure.last_failure_kind,
    last_failure_event_id: failure.last_failure_event_id,
    last_failure_dispatch_id: failure.last_failure_dispatch_id,
    last_failure_message_id: failure.last_failure_message_id,
    last_failure_task_id: failure.last_failure_task_id,
    error_streak: session.errorStreak ?? 0,
    timeout_streak: session.timeoutStreak ?? 0,
    retryable: failure.retryable,
    code: failure.code,
    message: failure.message,
    next_action: failure.next_action,
    raw_status: failure.raw_status,
    last_event_type: failure.last_event_type,
    can_dismiss: policy.can_dismiss,
    can_repair_to_idle: policy.can_repair_to_idle,
    can_repair_to_blocked: policy.can_repair_to_blocked,
    can_retry_dispatch: policy.can_retry_dispatch,
    disabled_reason: policy.disabled_reason,
    risk: policy.risk,
    requires_confirmation: policy.requires_confirmation,
    latest_events: latestAuditBySession.get(session.sessionId) ?? [],
    recovery_attempts: attemptsBySession.get(session.sessionId) ?? []
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
  const sessionStatuses = new Map(sessions.map((session) => [session.sessionId, session.status] as const));
  const latestFailureBySession = indexLatestFailureEvents(events);
  const latestAuditBySession = indexRecoveryAuditEvents(events);
  const attemptsBySession = indexRecoveryAttempts(events, sessionStatuses);
  const nowMs = Date.now();
  const items = sessions
    .map((session) =>
      buildProjectRecoveryItem(
        session,
        scope.project,
        tasksById,
        latestFailureBySession,
        latestAuditBySession,
        attemptsBySession
      )
    )
    .filter((item) => isRecoveryCandidate(item, nowMs))
    .sort((left, right) => left.role.localeCompare(right.role) || left.session_id.localeCompare(right.session_id));
  return {
    scope_kind: "project",
    scope_id: scope.project.projectId,
    generated_at: new Date(nowMs).toISOString(),
    summary: summarizeItems(items, sessions.length, nowMs),
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
  const sessionStatuses = new Map(sessions.map((session) => [session.sessionId, session.status] as const));
  const latestFailureBySession = indexLatestFailureEvents(events);
  const latestAuditBySession = indexRecoveryAuditEvents(events);
  const attemptsBySession = indexRecoveryAttempts(events, sessionStatuses);
  const nowMs = Date.now();
  const items = sessions
    .map((session) =>
      buildWorkflowRecoveryItem(
        session,
        scope.run,
        runtimeTasksById,
        latestFailureBySession,
        latestAuditBySession,
        attemptsBySession
      )
    )
    .filter((item) => isRecoveryCandidate(item, nowMs))
    .sort((left, right) => left.role.localeCompare(right.role) || left.session_id.localeCompare(right.session_id));
  return {
    scope_kind: "workflow",
    scope_id: scope.run.runId,
    generated_at: new Date(nowMs).toISOString(),
    summary: summarizeItems(items, sessions.length, nowMs),
    items
  };
}
