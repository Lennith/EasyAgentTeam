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

export interface RuntimeRecoveryAttemptIndexOptions {
  attempt_limit?: RecoveryAttemptLimit;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveEventTypeOrder(eventType: string | undefined): number {
  return EVENT_TYPE_ORDER.get(eventType ?? "") ?? Number.MAX_SAFE_INTEGER;
}

export function compareRecoveryEventsAsc<TEvent extends { createdAt: string; eventId: string; eventType?: string }>(
  left: TEvent,
  right: TEvent
): number {
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

export function compareRecoveryEventsDesc<TEvent extends { createdAt: string; eventId: string; eventType?: string }>(
  left: TEvent,
  right: TEvent
): number {
  return compareRecoveryEventsAsc(right, left);
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
  const events = [...rawEvents].sort(compareRecoveryEventsAsc);
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

function resolveAttemptLimit(limit: RecoveryAttemptLimit | undefined): number | null {
  if (limit === "all") {
    return null;
  }
  if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) {
    return limit;
  }
  return DEFAULT_RECOVERY_ATTEMPT_LIMIT;
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

  const limit = resolveAttemptLimit(options.attempt_limit);
  const result = new Map<string, RuntimeRecoveryAttempt[]>();
  for (const [sessionId, attempts] of attemptsBySession.entries()) {
    const sortedAttemptInputs = [...attempts.entries()]
      .map(([recoveryAttemptId, attemptEvents]) => ({
        recoveryAttemptId,
        attemptEvents: [...attemptEvents].sort(compareRecoveryEventsAsc)
      }))
      .sort((left, right) => {
        const leftLast = left.attemptEvents[left.attemptEvents.length - 1]!;
        const rightLast = right.attemptEvents[right.attemptEvents.length - 1]!;
        return compareRecoveryEventsDesc(leftLast, rightLast);
      });
    const limitedAttemptInputs = limit === null ? sortedAttemptInputs : sortedAttemptInputs.slice(0, limit);
    const sortedAttempts = limitedAttemptInputs.map((attempt, index) =>
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
