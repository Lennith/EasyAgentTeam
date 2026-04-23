import type { RecoveryScopeKind, RecoveryStatus } from "./runtime-recovery-action-policy.js";
import {
  RECOVERY_AUDIT_EVENT_TYPES,
  RECOVERY_ATTEMPT_EVENT_TYPES,
  DEFAULT_RECOVERY_ATTEMPT_LIMIT,
  RUNNER_FAILURE_EVENT_TYPES,
  buildRecoveryAttempt,
  compareRecoveryEventsAsc,
  compareRecoveryEventsDesc,
  readRecoveryAttemptId,
  summarizeRecoveryEventPayload,
  type RecoveryAttemptLimit,
  type RuntimeRecoveryAttempt,
  type RuntimeRecoveryEventSummary
} from "./runtime-recovery-attempts.js";
import { readJsonFile, readJsonlLines, writeJsonFile } from "../data/internal/persistence/store/store-runtime.js";

const INDEX_SCHEMA_VERSION = "1.0";
const RECOVERY_EVENT_SUMMARY_LIMIT = 4;

export interface RecoveryIndexableEvent {
  eventId: string;
  eventType: string;
  createdAt: string;
  sessionId?: string;
  taskId?: string;
  payload: Record<string, unknown>;
}

export interface RecoveryIndexedEvent {
  event_id: string;
  event_type: string;
  created_at: string;
  session_id: string;
  task_id: string | null;
  payload: Record<string, unknown>;
}

export interface RecoveryIndexedAttempt {
  recovery_attempt_id: string;
  last_event_at: string;
  events: RecoveryIndexedEvent[];
}

export interface RecoveryEventIndexSession {
  session_id: string;
  latest_failure_event: RecoveryIndexedEvent | null;
  latest_audit_events: RecoveryIndexedEvent[];
  recovery_attempts: Record<string, RecoveryIndexedAttempt>;
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

function isValidIndex(value: unknown, scope: RecoveryEventIndexScope): value is RecoveryEventIndexState {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schemaVersion === INDEX_SCHEMA_VERSION &&
    value.scope_kind === scope.scope_kind &&
    value.scope_id === scope.scope_id &&
    isRecord(value.sessions)
  );
}

function toIndexedEvent(event: RecoveryIndexableEvent): RecoveryIndexedEvent | null {
  if (!event.sessionId) {
    return null;
  }
  return {
    event_id: event.eventId,
    event_type: event.eventType,
    created_at: event.createdAt,
    session_id: event.sessionId,
    task_id: event.taskId ?? null,
    payload: event.payload ?? {}
  };
}

function fromIndexedEvent(event: RecoveryIndexedEvent): RecoveryIndexableEvent {
  return {
    eventId: event.event_id,
    eventType: event.event_type,
    createdAt: event.created_at,
    sessionId: event.session_id,
    taskId: event.task_id ?? undefined,
    payload: event.payload
  };
}

function getOrCreateSession(index: RecoveryEventIndexState, sessionId: string): RecoveryEventIndexSession {
  const existing = index.sessions[sessionId];
  if (existing) {
    existing.latest_audit_events = existing.latest_audit_events ?? [];
    existing.recovery_attempts = existing.recovery_attempts ?? {};
    return existing;
  }
  const created: RecoveryEventIndexSession = {
    session_id: sessionId,
    latest_failure_event: null,
    latest_audit_events: [],
    recovery_attempts: {}
  };
  index.sessions[sessionId] = created;
  return created;
}

function upsertIndexedEvent(events: RecoveryIndexedEvent[], event: RecoveryIndexedEvent): RecoveryIndexedEvent[] {
  const next = events.filter((item) => item.event_id !== event.event_id);
  next.push(event);
  return next.sort((left, right) => compareRecoveryEventsDesc(fromIndexedEvent(left), fromIndexedEvent(right)));
}

export function applyRecoveryEventToIndex(index: RecoveryEventIndexState, event: RecoveryIndexableEvent): boolean {
  const indexed = toIndexedEvent(event);
  if (!indexed) {
    return false;
  }

  let changed = false;
  const session = getOrCreateSession(index, indexed.session_id);
  if (RUNNER_FAILURE_EVENT_TYPES.has(indexed.event_type)) {
    const current = session.latest_failure_event;
    if (!current || compareRecoveryEventsDesc(fromIndexedEvent(indexed), fromIndexedEvent(current)) < 0) {
      session.latest_failure_event = indexed;
      changed = true;
    }
  }

  if (RECOVERY_AUDIT_EVENT_TYPES.has(indexed.event_type)) {
    session.latest_audit_events = upsertIndexedEvent(session.latest_audit_events, indexed).slice(
      0,
      RECOVERY_EVENT_SUMMARY_LIMIT
    );
    changed = true;
  }

  if (RECOVERY_ATTEMPT_EVENT_TYPES.has(indexed.event_type)) {
    const recoveryAttemptId = readRecoveryAttemptId(indexed.payload);
    if (recoveryAttemptId) {
      const current = session.recovery_attempts[recoveryAttemptId] ?? {
        recovery_attempt_id: recoveryAttemptId,
        last_event_at: indexed.created_at,
        events: []
      };
      current.events = upsertIndexedEvent(current.events, indexed).sort((left, right) =>
        compareRecoveryEventsAsc(fromIndexedEvent(left), fromIndexedEvent(right))
      );
      current.last_event_at = current.events[current.events.length - 1]?.created_at ?? indexed.created_at;
      session.recovery_attempts[recoveryAttemptId] = current;
      changed = true;
    }
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
      result.set(session.session_id, fromIndexedEvent(session.latest_failure_event));
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
        event_type: event.event_type,
        created_at: event.created_at,
        payload_summary: summarizeRecoveryEventPayload(event.event_type, event.payload, event.task_id)
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

export function getRecoveryAttemptsFromIndex(
  index: RecoveryEventIndexState,
  sessionStatuses: ReadonlyMap<string, RecoveryStatus>,
  options: { attempt_limit?: RecoveryAttemptLimit } = {}
): Map<string, RuntimeRecoveryAttempt[]> {
  const limit = resolveAttemptLimit(options.attempt_limit);
  const result = new Map<string, RuntimeRecoveryAttempt[]>();
  for (const session of Object.values(index.sessions)) {
    const sorted = Object.values(session.recovery_attempts ?? {}).sort((left, right) => {
      const leftLast = left.events[left.events.length - 1];
      const rightLast = right.events[right.events.length - 1];
      if (!leftLast || !rightLast) {
        return 0;
      }
      return compareRecoveryEventsDesc(fromIndexedEvent(leftLast), fromIndexedEvent(rightLast));
    });
    const limited = limit === null ? sorted : sorted.slice(0, limit);
    result.set(
      session.session_id,
      limited.map((attempt, index) =>
        buildRecoveryAttempt(
          attempt.recovery_attempt_id,
          attempt.events.map(fromIndexedEvent),
          sessionStatuses.get(session.session_id) ?? "idle",
          index === 0
        )
      )
    );
  }
  return result;
}

export function getSessionRecoveryAttemptsFromIndex(
  index: RecoveryEventIndexState,
  sessionId: string,
  sessionStatus: RecoveryStatus,
  options: { attempt_limit?: RecoveryAttemptLimit } = {}
): { attempts: RuntimeRecoveryAttempt[]; total: number; truncated: boolean } {
  const session = index.sessions[sessionId];
  if (!session) {
    return { attempts: [], total: 0, truncated: false };
  }
  const sorted = Object.values(session.recovery_attempts ?? {}).sort((left, right) => {
    const leftLast = left.events[left.events.length - 1];
    const rightLast = right.events[right.events.length - 1];
    if (!leftLast || !rightLast) {
      return 0;
    }
    return compareRecoveryEventsDesc(fromIndexedEvent(leftLast), fromIndexedEvent(rightLast));
  });
  const limit = resolveAttemptLimit(options.attempt_limit);
  const limited = limit === null ? sorted : sorted.slice(0, limit);
  return {
    attempts: limited.map((attempt, index) =>
      buildRecoveryAttempt(
        attempt.recovery_attempt_id,
        attempt.events.map(fromIndexedEvent),
        sessionStatus,
        index === 0
      )
    ),
    total: sorted.length,
    truncated: limit !== null && sorted.length > limit
  };
}
