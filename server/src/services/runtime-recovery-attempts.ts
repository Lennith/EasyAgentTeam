import type { RecoveryStatus } from "./runtime-recovery-action-policy.js";

export const DEFAULT_RECOVERY_ATTEMPT_LIMIT = 5;
export const MAX_RECOVERY_ATTEMPT_LIMIT = 100;

export type RecoveryAttemptLimit = number | "all";

export const RUNNER_FAILURE_EVENT_TYPES = new Set([
  "RUNNER_CONFIG_ERROR_BLOCKED",
  "RUNNER_TRANSIENT_ERROR_SOFT",
  "RUNNER_RUNTIME_ERROR_SOFT",
  "RUNNER_FATAL_ERROR_DISMISSED",
  "RUNNER_TIMEOUT_SOFT",
  "RUNNER_TIMEOUT_ESCALATED"
]);

export const RECOVERY_AUDIT_EVENT_TYPES = new Set([
  ...RUNNER_FAILURE_EVENT_TYPES,
  "SESSION_DISMISS_EXTERNAL_RESULT",
  "SESSION_STATUS_REPAIRED",
  "SESSION_STATUS_DISMISSED",
  "SESSION_RETRY_DISPATCH_REQUESTED",
  "SESSION_RETRY_DISPATCH_ACCEPTED",
  "SESSION_RETRY_DISPATCH_REJECTED"
]);

export const RECOVERY_ATTEMPT_EVENT_TYPES = new Set([
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

const EVENT_TYPE_ORDER = new Map<string, number>([
  ["RUNNER_CONFIG_ERROR_BLOCKED", 10],
  ["RUNNER_TRANSIENT_ERROR_SOFT", 11],
  ["RUNNER_RUNTIME_ERROR_SOFT", 12],
  ["RUNNER_FATAL_ERROR_DISMISSED", 13],
  ["RUNNER_TIMEOUT_SOFT", 14],
  ["RUNNER_TIMEOUT_ESCALATED", 15],
  ["SESSION_DISMISS_EXTERNAL_RESULT", 20],
  ["SESSION_STATUS_REPAIRED", 21],
  ["SESSION_STATUS_DISMISSED", 22],
  ["SESSION_RETRY_DISPATCH_REQUESTED", 30],
  ["SESSION_RETRY_DISPATCH_ACCEPTED", 31],
  ["SESSION_RETRY_DISPATCH_REJECTED", 32],
  ["ORCHESTRATOR_DISPATCH_STARTED", 33],
  ["ORCHESTRATOR_DISPATCH_FINISHED", 34],
  ["ORCHESTRATOR_DISPATCH_FAILED", 35]
]);

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

export interface RuntimeRecoveryAttemptPreview {
  recovery_attempt_id: string;
  status: RuntimeRecoveryAttemptStatus;
  integrity: RuntimeRecoveryAttemptIntegrity;
  missing_markers: RuntimeRecoveryAttemptMissingMarker[];
  requested_at: string | null;
  last_event_at: string;
  ended_at: string | null;
  dispatch_scope: "task" | "role" | null;
  current_task_id: string | null;
}

export interface RuntimeRecoveryAttempt extends RuntimeRecoveryAttemptPreview {
  events: RuntimeRecoveryEventSummary[];
}

export interface RecoveryAttemptPreviewState extends RuntimeRecoveryAttemptPreview {
  last_event_id: string;
  last_event_type: string;
  has_requested: boolean;
  has_accepted: boolean;
  has_rejected: boolean;
  has_dispatch_started: boolean;
  has_dispatch_finished: boolean;
  has_dispatch_failed: boolean;
}

export interface RuntimeRecoveryAttemptIndexOptions {
  attempt_limit?: RecoveryAttemptLimit;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isRunnerFailureEventType(eventType: string): boolean {
  return RUNNER_FAILURE_EVENT_TYPES.has(eventType);
}

export function isRecoveryAttemptEventType(eventType: string): boolean {
  return RECOVERY_ATTEMPT_EVENT_TYPES.has(eventType);
}

export function isRecoveryAuditEventType(eventType: string): boolean {
  return RECOVERY_AUDIT_EVENT_TYPES.has(eventType) || eventType.startsWith("SESSION_STATUS_");
}

export function isRecoverySidecarRelevantEventType(eventType: string): boolean {
  return (
    isRunnerFailureEventType(eventType) ||
    isRecoveryAttemptEventType(eventType) ||
    eventType === "SESSION_DISMISS_EXTERNAL_RESULT" ||
    eventType.startsWith("SESSION_STATUS_")
  );
}

function resolveEventTypeOrder(eventType: string | undefined): number {
  return EVENT_TYPE_ORDER.get(eventType ?? "") ?? Number.MAX_SAFE_INTEGER;
}

export function compareRecoveryEventsAsc<
  TLeft extends { createdAt: string; eventId: string; eventType?: string },
  TRight extends { createdAt: string; eventId: string; eventType?: string }
>(left: TLeft, right: TRight): number {
  const timeDiff = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (timeDiff !== 0) {
    return timeDiff;
  }
  const typeDiff = resolveEventTypeOrder(left.eventType) - resolveEventTypeOrder(right.eventType);
  if (typeDiff !== 0) {
    return typeDiff;
  }
  return left.eventId.localeCompare(right.eventId);
}

export function compareRecoveryEventsDesc<
  TLeft extends { createdAt: string; eventId: string; eventType?: string },
  TRight extends { createdAt: string; eventId: string; eventType?: string }
>(left: TLeft, right: TRight): number {
  return compareRecoveryEventsAsc(right, left);
}

function readDispatchKind(payload: Record<string, unknown>): string | null {
  return readString(payload.dispatchKind ?? payload.dispatch_kind ?? asRecord(payload.options).dispatchKind);
}

export function readRecoveryAttemptId(payload: Record<string, unknown>): string | null {
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

function resolveAttemptStatusFromState(state: RecoveryAttemptPreviewState): RuntimeRecoveryAttemptStatus {
  if (state.has_rejected) {
    return "rejected";
  }
  if (state.has_dispatch_failed) {
    return "failed";
  }
  if (state.has_dispatch_finished) {
    return "finished";
  }
  if (state.has_dispatch_started) {
    return "running";
  }
  if (state.has_accepted) {
    return "accepted";
  }
  return "requested";
}

function resolveMissingMarkers(
  state: RecoveryAttemptPreviewState,
  sessionStatus: RecoveryStatus,
  isLatestAttempt: boolean
): RuntimeRecoveryAttemptMissingMarker[] {
  const hasDecision = state.has_accepted || state.has_rejected;
  const hasDispatchTerminal = state.has_dispatch_finished || state.has_dispatch_failed;
  const isInflight =
    state.has_accepted &&
    state.has_dispatch_started &&
    !hasDispatchTerminal &&
    !state.has_rejected &&
    isLatestAttempt &&
    sessionStatus === "running";
  const missing = new Set<RuntimeRecoveryAttemptMissingMarker>();

  if (!state.has_requested) {
    missing.add("requested");
  }
  if (!hasDecision) {
    missing.add("accepted_or_rejected");
  }
  if (
    !state.has_rejected &&
    (state.has_accepted || state.has_dispatch_started || hasDispatchTerminal) &&
    !state.has_dispatch_started
  ) {
    missing.add("dispatch_started");
  }
  if (!state.has_rejected && state.has_dispatch_started && !hasDispatchTerminal && !isInflight) {
    missing.add("dispatch_terminal");
  }
  return [...missing];
}

function readCurrentTaskId<TEvent extends { taskId?: string; payload: Record<string, unknown> }>(
  event: TEvent
): string | null {
  const payload = asRecord(event.payload);
  return readString(payload.current_task_id ?? payload.currentTaskId ?? payload.task_id) ?? event.taskId ?? null;
}

function readDispatchScope<TEvent extends { taskId?: string; payload: Record<string, unknown> }>(
  event: TEvent
): "task" | "role" | null {
  const payload = asRecord(event.payload);
  const direct = normalizeDispatchScope(readString(payload.dispatch_scope), event.taskId ?? null);
  if (direct) {
    return direct;
  }
  return normalizeDispatchScope(readDispatchKind(payload), event.taskId ?? null);
}

export function createRecoveryAttemptPreviewState<
  TEvent extends {
    eventId: string;
    eventType: string;
    createdAt: string;
    taskId?: string;
    payload: Record<string, unknown>;
  }
>(recoveryAttemptId: string, event: TEvent): RecoveryAttemptPreviewState {
  const currentTaskId = readCurrentTaskId(event);
  const dispatchScope = readDispatchScope(event);
  const state: RecoveryAttemptPreviewState = {
    recovery_attempt_id: recoveryAttemptId,
    status: "requested",
    integrity: "incomplete",
    missing_markers: ["accepted_or_rejected"],
    requested_at: null,
    last_event_at: event.createdAt,
    ended_at: null,
    dispatch_scope: dispatchScope,
    current_task_id: currentTaskId,
    last_event_id: event.eventId,
    last_event_type: event.eventType,
    has_requested: false,
    has_accepted: false,
    has_rejected: false,
    has_dispatch_started: false,
    has_dispatch_finished: false,
    has_dispatch_failed: false
  };
  return applyRecoveryAttemptEventToPreviewState(state, event);
}

export function applyRecoveryAttemptEventToPreviewState<
  TEvent extends {
    eventId: string;
    eventType: string;
    createdAt: string;
    taskId?: string;
    payload: Record<string, unknown>;
  }
>(current: RecoveryAttemptPreviewState, event: TEvent): RecoveryAttemptPreviewState {
  const next: RecoveryAttemptPreviewState = { ...current };
  if (event.eventType === "SESSION_RETRY_DISPATCH_REQUESTED") {
    next.has_requested = true;
    next.requested_at =
      !next.requested_at ||
      compareRecoveryEventsAsc(event, {
        createdAt: next.requested_at,
        eventId: next.last_event_id,
        eventType: "SESSION_RETRY_DISPATCH_REQUESTED"
      }) < 0
        ? event.createdAt
        : next.requested_at;
  } else if (event.eventType === "SESSION_RETRY_DISPATCH_ACCEPTED") {
    next.has_accepted = true;
  } else if (event.eventType === "SESSION_RETRY_DISPATCH_REJECTED") {
    next.has_rejected = true;
    next.ended_at = event.createdAt;
  } else if (event.eventType === "ORCHESTRATOR_DISPATCH_STARTED") {
    next.has_dispatch_started = true;
  } else if (event.eventType === "ORCHESTRATOR_DISPATCH_FINISHED") {
    next.has_dispatch_started = true;
    next.has_dispatch_finished = true;
    next.ended_at = event.createdAt;
  } else if (event.eventType === "ORCHESTRATOR_DISPATCH_FAILED") {
    next.has_dispatch_started = true;
    next.has_dispatch_failed = true;
    next.ended_at = event.createdAt;
  }

  const currentTaskId = readCurrentTaskId(event);
  if (currentTaskId) {
    next.current_task_id = currentTaskId;
  }
  const dispatchScope = readDispatchScope(event);
  if (dispatchScope) {
    next.dispatch_scope = dispatchScope;
  }

  if (
    compareRecoveryEventsDesc(event, {
      createdAt: next.last_event_at,
      eventId: next.last_event_id,
      eventType: next.last_event_type
    }) < 0
  ) {
    next.last_event_at = event.createdAt;
    next.last_event_id = event.eventId;
    next.last_event_type = event.eventType;
  }

  return next;
}

export function buildRecoveryAttemptPreviewFromState(
  state: RecoveryAttemptPreviewState,
  sessionStatus: RecoveryStatus,
  isLatestAttempt: boolean
): RuntimeRecoveryAttemptPreview {
  const missingMarkers = resolveMissingMarkers(state, sessionStatus, isLatestAttempt);
  return {
    recovery_attempt_id: state.recovery_attempt_id,
    status: resolveAttemptStatusFromState(state),
    integrity: missingMarkers.length === 0 ? "complete" : "incomplete",
    missing_markers: missingMarkers,
    requested_at: state.requested_at,
    last_event_at: state.last_event_at,
    ended_at: state.ended_at,
    dispatch_scope: state.dispatch_scope,
    current_task_id: state.current_task_id
  };
}

export function buildRecoveryAttemptPreviewFromEvents<
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
): RuntimeRecoveryAttemptPreview {
  const state = buildRecoveryAttemptPreviewStateFromEvents(recoveryAttemptId, rawEvents);
  return buildRecoveryAttemptPreviewFromState(state, sessionStatus, isLatestAttempt);
}

export function buildRecoveryAttemptPreviewStateFromEvents<
  TEvent extends {
    eventId: string;
    eventType: string;
    createdAt: string;
    taskId?: string;
    payload: Record<string, unknown>;
  }
>(recoveryAttemptId: string, rawEvents: readonly TEvent[]): RecoveryAttemptPreviewState {
  const events = [...rawEvents].sort(compareRecoveryEventsAsc);
  const first = events[0];
  if (!first) {
    throw new Error(`attempt '${recoveryAttemptId}' has no events`);
  }
  return events
    .slice(1)
    .reduce(
      (state, event) => applyRecoveryAttemptEventToPreviewState(state, event),
      createRecoveryAttemptPreviewState(recoveryAttemptId, first)
    );
}

export function summarizeRecoveryEventPayload(
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

export function buildRecoveryAttempt<
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
  const events = [...rawEvents].sort(compareRecoveryEventsAsc);
  const preview = buildRecoveryAttemptPreviewFromEvents(recoveryAttemptId, events, sessionStatus, isLatestAttempt);
  return {
    ...preview,
    events: events.map((event) => buildRecoveryAttemptEventSummary(event))
  };
}

function resolveAttemptLimit(limit: RecoveryAttemptLimit | undefined): number | null {
  if (limit === "all") {
    return null;
  }
  if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) {
    return limit;
  }
  return DEFAULT_RECOVERY_ATTEMPT_LIMIT;
}

function buildAttemptInputs<
  TEvent extends {
    eventId: string;
    eventType: string;
    createdAt: string;
    sessionId?: string;
    payload: Record<string, unknown>;
  }
>(events: readonly TEvent[]): Map<string, Map<string, TEvent[]>> {
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
  return attemptsBySession;
}

function sortAttemptInputs<
  TEvent extends {
    eventId: string;
    eventType: string;
    createdAt: string;
    taskId?: string;
    payload: Record<string, unknown>;
  }
>(attempts: ReadonlyMap<string, readonly TEvent[]>): Array<{ recoveryAttemptId: string; attemptEvents: TEvent[] }> {
  return [...attempts.entries()]
    .map(([recoveryAttemptId, attemptEvents]) => ({
      recoveryAttemptId,
      attemptEvents: [...attemptEvents].sort(compareRecoveryEventsAsc)
    }))
    .sort((left, right) => {
      const leftLast = left.attemptEvents[left.attemptEvents.length - 1];
      const rightLast = right.attemptEvents[right.attemptEvents.length - 1];
      if (!leftLast || !rightLast) {
        return 0;
      }
      return compareRecoveryEventsDesc(leftLast, rightLast);
    });
}

export function buildSessionRecoveryAttempts<
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
  sessionId: string,
  sessionStatus: RecoveryStatus,
  options: RuntimeRecoveryAttemptIndexOptions = {}
): { attempts: RuntimeRecoveryAttempt[]; total: number; truncated: boolean } {
  const attemptsBySession = buildAttemptInputs(events);
  const sortedAttemptInputs = sortAttemptInputs(attemptsBySession.get(sessionId) ?? new Map());
  const limit = resolveAttemptLimit(options.attempt_limit);
  const limitedAttemptInputs = limit === null ? sortedAttemptInputs : sortedAttemptInputs.slice(0, limit);
  return {
    attempts: limitedAttemptInputs.map((attempt, index) =>
      buildRecoveryAttempt(attempt.recoveryAttemptId, attempt.attemptEvents, sessionStatus, index === 0)
    ),
    total: sortedAttemptInputs.length,
    truncated: limit !== null && sortedAttemptInputs.length > limit
  };
}

export function indexRecoveryAttempts<
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
  sessionStatuses: ReadonlyMap<string, RecoveryStatus>,
  options: RuntimeRecoveryAttemptIndexOptions = {}
): Map<string, RuntimeRecoveryAttempt[]> {
  const attemptsBySession = buildAttemptInputs(events);
  const limit = resolveAttemptLimit(options.attempt_limit);
  const result = new Map<string, RuntimeRecoveryAttempt[]>();
  for (const [sessionId, attempts] of attemptsBySession.entries()) {
    const sortedAttemptInputs = sortAttemptInputs(attempts);
    const limitedAttemptInputs = limit === null ? sortedAttemptInputs : sortedAttemptInputs.slice(0, limit);
    result.set(
      sessionId,
      limitedAttemptInputs.map((attempt, index) =>
        buildRecoveryAttempt(
          attempt.recoveryAttemptId,
          attempt.attemptEvents,
          sessionStatuses.get(sessionId) ?? "idle",
          index === 0
        )
      )
    );
  }
  return result;
}
