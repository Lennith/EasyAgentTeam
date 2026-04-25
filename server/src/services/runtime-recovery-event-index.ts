import type { RecoveryScopeKind, RecoveryStatus } from "./runtime-recovery-action-policy.js";
import {
  DEFAULT_RECOVERY_ATTEMPT_LIMIT,
  MAX_RECOVERY_ATTEMPT_LIMIT,
  applyRecoveryAttemptEventToPreviewState,
  buildRecoveryAttemptPreviewFromState,
  compareRecoveryEventsDesc,
  isRecoveryAttemptEventType,
  isRecoveryAuditEventType,
  isRecoverySidecarRelevantEventType,
  isRunnerFailureEventType,
  readRecoveryAttemptId,
  summarizeRecoveryEventPayload,
  type RecoveryAttemptLimit,
  type RecoveryAttemptPreviewState,
  type RuntimeRecoveryAttemptPreview,
  type RuntimeRecoveryEventSummary
} from "./runtime-recovery-attempts.js";
import { readJsonFile, readJsonlLines, writeJsonFile } from "../data/internal/persistence/store/store-runtime.js";

const INDEX_SCHEMA_VERSION = "2.0";
const RECOVERY_EVENT_SUMMARY_LIMIT = 4;
const HOT_RECOVERY_ATTEMPT_LIMIT = MAX_RECOVERY_ATTEMPT_LIMIT;

export interface RecoveryIndexableEvent {
  eventId: string;
  eventType: string;
  createdAt: string;
  sessionId?: string;
  taskId?: string;
  payload: Record<string, unknown>;
}

export interface RecoveryEventIndexSession {
  session_id: string;
  latest_failure_event: RecoveryIndexableEvent | null;
  latest_audit_events: RecoveryIndexableEvent[];
  recent_attempts: RecoveryAttemptPreviewState[];
}

export interface RecoveryEventIndexState {
  schemaVersion: typeof INDEX_SCHEMA_VERSION;
  scope_kind: RecoveryScopeKind;
  scope_id: string;
  updated_at: string;
  sessions: Record<string, RecoveryEventIndexSession>;
}

export interface RecoveryEventIndexScope {
  scope_kind: RecoveryScopeKind;
  scope_id: string;
  index_file: string;
  events_file: string;
  attempt_archive_dir: string;
}

function emptyIndex(scope: RecoveryEventIndexScope): RecoveryEventIndexState {
  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    scope_kind: scope.scope_kind,
    scope_id: scope.scope_id,
    updated_at: new Date(0).toISOString(),
    sessions: {}
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidPreviewState(value: unknown): value is RecoveryAttemptPreviewState {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.recovery_attempt_id === "string" &&
    typeof value.last_event_at === "string" &&
    typeof value.last_event_id === "string" &&
    typeof value.last_event_type === "string" &&
    typeof value.has_requested === "boolean" &&
    typeof value.has_accepted === "boolean" &&
    typeof value.has_rejected === "boolean" &&
    typeof value.has_dispatch_started === "boolean" &&
    typeof value.has_dispatch_finished === "boolean" &&
    typeof value.has_dispatch_failed === "boolean"
  );
}

function isValidEvent(value: unknown): value is RecoveryIndexableEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.eventId === "string" &&
    typeof value.eventType === "string" &&
    typeof value.createdAt === "string" &&
    isRecord(value.payload)
  );
}

function isValidSession(value: unknown): value is RecoveryEventIndexSession {
  if (!isRecord(value) || typeof value.session_id !== "string") {
    return false;
  }
  if (
    value.latest_failure_event !== null &&
    value.latest_failure_event !== undefined &&
    !isValidEvent(value.latest_failure_event)
  ) {
    return false;
  }
  if (!Array.isArray(value.latest_audit_events) || !value.latest_audit_events.every(isValidEvent)) {
    return false;
  }
  if (!Array.isArray(value.recent_attempts) || !value.recent_attempts.every(isValidPreviewState)) {
    return false;
  }
  return true;
}

function isValidIndex(value: unknown, scope: RecoveryEventIndexScope): value is RecoveryEventIndexState {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.schemaVersion !== INDEX_SCHEMA_VERSION ||
    value.scope_kind !== scope.scope_kind ||
    value.scope_id !== scope.scope_id ||
    !isRecord(value.sessions)
  ) {
    return false;
  }
  return Object.values(value.sessions).every(isValidSession);
}

function getOrCreateSession(index: RecoveryEventIndexState, sessionId: string): RecoveryEventIndexSession {
  const existing = index.sessions[sessionId];
  if (existing) {
    existing.latest_audit_events = existing.latest_audit_events ?? [];
    existing.recent_attempts = existing.recent_attempts ?? [];
    return existing;
  }
  const created: RecoveryEventIndexSession = {
    session_id: sessionId,
    latest_failure_event: null,
    latest_audit_events: [],
    recent_attempts: []
  };
  index.sessions[sessionId] = created;
  return created;
}

function upsertLatestAuditEvents(
  events: RecoveryIndexableEvent[],
  event: RecoveryIndexableEvent
): RecoveryIndexableEvent[] {
  const next = events.filter((item) => item.eventId !== event.eventId);
  next.push(event);
  return next.sort(compareRecoveryEventsDesc).slice(0, RECOVERY_EVENT_SUMMARY_LIMIT);
}

function upsertRecentAttemptPreview(
  attempts: RecoveryAttemptPreviewState[],
  event: RecoveryIndexableEvent
): RecoveryAttemptPreviewState[] {
  const recoveryAttemptId = readRecoveryAttemptId(event.payload);
  if (!recoveryAttemptId) {
    return attempts;
  }
  const existing = attempts.find((item) => item.recovery_attempt_id === recoveryAttemptId);
  const nextPreview = existing
    ? applyRecoveryAttemptEventToPreviewState(existing, event)
    : applyRecoveryAttemptEventToPreviewState(
        {
          recovery_attempt_id: recoveryAttemptId,
          status: "requested",
          integrity: "incomplete",
          missing_markers: ["accepted_or_rejected"],
          requested_at: null,
          last_event_at: event.createdAt,
          ended_at: null,
          dispatch_scope: null,
          current_task_id: null,
          last_event_id: event.eventId,
          last_event_type: event.eventType,
          has_requested: false,
          has_accepted: false,
          has_rejected: false,
          has_dispatch_started: false,
          has_dispatch_finished: false,
          has_dispatch_failed: false
        },
        event
      );
  const next = attempts.filter((item) => item.recovery_attempt_id !== recoveryAttemptId);
  next.push(nextPreview);
  return next
    .sort((left, right) =>
      compareRecoveryEventsDesc(
        { eventId: left.last_event_id, eventType: left.last_event_type, createdAt: left.last_event_at },
        { eventId: right.last_event_id, eventType: right.last_event_type, createdAt: right.last_event_at }
      )
    )
    .slice(0, HOT_RECOVERY_ATTEMPT_LIMIT);
}

export function applyRecoveryEventToIndex(index: RecoveryEventIndexState, event: RecoveryIndexableEvent): boolean {
  if (!event.sessionId || !isRecoverySidecarRelevantEventType(event.eventType)) {
    return false;
  }

  let changed = false;
  const session = getOrCreateSession(index, event.sessionId);
  if (isRunnerFailureEventType(event.eventType)) {
    const current = session.latest_failure_event;
    if (!current || compareRecoveryEventsDesc(event, current) < 0) {
      session.latest_failure_event = event;
      changed = true;
    }
  }

  if (isRecoveryAuditEventType(event.eventType)) {
    session.latest_audit_events = upsertLatestAuditEvents(session.latest_audit_events, event);
    changed = true;
  }

  if (isRecoveryAttemptEventType(event.eventType)) {
    session.recent_attempts = upsertRecentAttemptPreview(session.recent_attempts, event);
    changed = true;
  }

  if (changed) {
    index.updated_at = new Date().toISOString();
  }
  return changed;
}

async function buildRecoveryEventIndex(scope: RecoveryEventIndexScope): Promise<RecoveryEventIndexState> {
  const events = await readJsonlLines<RecoveryIndexableEvent>(scope.events_file);
  const index = emptyIndex(scope);
  for (const event of events) {
    if (!isRecoverySidecarRelevantEventType(event.eventType)) {
      continue;
    }
    applyRecoveryEventToIndex(index, event);
  }
  index.updated_at = new Date().toISOString();
  await writeJsonFile(scope.index_file, index);
  return index;
}

export async function readRecoveryEventIndex(scope: RecoveryEventIndexScope): Promise<RecoveryEventIndexState> {
  try {
    const state = await readJsonFile<unknown>(scope.index_file, null);
    if (isValidIndex(state, scope)) {
      return state;
    }
  } catch {
    // Corrupt legacy sidecar indexes are repairable from the append-only event log.
  }
  return buildRecoveryEventIndex(scope);
}

export async function appendRecoveryEventToIndex(
  scope: RecoveryEventIndexScope,
  event: RecoveryIndexableEvent
): Promise<void> {
  if (!isRecoverySidecarRelevantEventType(event.eventType)) {
    return;
  }
  const index = await readRecoveryEventIndex(scope);
  if (!applyRecoveryEventToIndex(index, event)) {
    return;
  }
  await writeJsonFile(scope.index_file, index);
}

export function getLatestFailureEventsFromIndex(index: RecoveryEventIndexState): Map<string, RecoveryIndexableEvent> {
  const result = new Map<string, RecoveryIndexableEvent>();
  for (const session of Object.values(index.sessions)) {
    if (session.latest_failure_event) {
      result.set(session.session_id, session.latest_failure_event);
    }
  }
  return result;
}

export function getLatestAuditEventsFromIndex(
  index: RecoveryEventIndexState
): Map<string, RuntimeRecoveryEventSummary[]> {
  const result = new Map<string, RuntimeRecoveryEventSummary[]>();
  for (const session of Object.values(index.sessions)) {
    result.set(
      session.session_id,
      (session.latest_audit_events ?? []).map((event) => ({
        event_type: event.eventType,
        created_at: event.createdAt,
        payload_summary: summarizeRecoveryEventPayload(event.eventType, event.payload, event.taskId ?? null)
      }))
    );
  }
  return result;
}

function resolveAttemptLimit(limit: RecoveryAttemptLimit | undefined): number | null {
  if (limit === "all") {
    return null;
  }
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_RECOVERY_ATTEMPT_LIMIT;
}

export function getRecoveryAttemptPreviewsFromIndex(
  index: RecoveryEventIndexState,
  sessionStatuses: ReadonlyMap<string, RecoveryStatus>,
  options: { attempt_limit?: RecoveryAttemptLimit } = {}
): Map<string, RuntimeRecoveryAttemptPreview[]> {
  const limit = resolveAttemptLimit(options.attempt_limit);
  const result = new Map<string, RuntimeRecoveryAttemptPreview[]>();
  for (const session of Object.values(index.sessions)) {
    const limited = limit === null ? session.recent_attempts : session.recent_attempts.slice(0, limit);
    result.set(
      session.session_id,
      limited.map((attempt, index) =>
        buildRecoveryAttemptPreviewFromState(attempt, sessionStatuses.get(session.session_id) ?? "idle", index === 0)
      )
    );
  }
  return result;
}
