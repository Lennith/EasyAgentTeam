import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "../domain/models.js";
import { retryProjectDispatchSession } from "../services/runtime-retry-dispatch-service.js";

function createSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = "2026-04-20T10:00:00.000Z";
  return {
    schemaVersion: "1.0",
    sessionId: overrides.sessionId ?? "session-dev",
    projectId: overrides.projectId ?? "project-alpha",
    role: overrides.role ?? "dev",
    provider: overrides.provider ?? "minimax",
    status: overrides.status ?? "idle",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    lastActiveAt: overrides.lastActiveAt ?? now,
    providerSessionId: overrides.providerSessionId ?? "provider-dev",
    currentTaskId: overrides.currentTaskId ?? "task-a",
    lastInboxMessageId: overrides.lastInboxMessageId,
    lastDispatchedAt: overrides.lastDispatchedAt,
    agentPid: overrides.agentPid,
    pendingConfirmedMessages: overrides.pendingConfirmedMessages,
    confirmedMessageIds: overrides.confirmedMessageIds,
    idleSince: overrides.idleSince,
    reminderCount: overrides.reminderCount,
    nextReminderAt: overrides.nextReminderAt,
    timeoutStreak: overrides.timeoutStreak ?? 0,
    errorStreak: overrides.errorStreak ?? 1,
    lastFailureAt: overrides.lastFailureAt ?? now,
    lastFailureKind: overrides.lastFailureKind ?? "error",
    lastFailureEventId: overrides.lastFailureEventId ?? "evt-failure",
    lastFailureDispatchId: overrides.lastFailureDispatchId,
    lastFailureMessageId: overrides.lastFailureMessageId,
    lastFailureTaskId: overrides.lastFailureTaskId ?? "task-a",
    lastRunId: overrides.lastRunId,
    lastDispatchId: overrides.lastDispatchId,
    cooldownUntil: overrides.cooldownUntil
  };
}

function buildOperations(
  initialSession: SessionRecord,
  options: {
    authoritativeSessionId?: string;
    dispatchAccepted?: boolean;
    dispatchReason?: string;
  } = {}
) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const dispatches: Array<{ scopeId: string; sessionId: string }> = [];
  let reminderResets = 0;
  let session = { ...initialSession };
  const scope = {
    projectId: session.projectId,
    roleSessionMap: { [session.role]: options.authoritativeSessionId ?? session.sessionId }
  };

  return {
    events,
    dispatches,
    get session() {
      return session;
    },
    get reminderResets() {
      return reminderResets;
    },
    operations: {
      loadScope: async () => scope,
      runInUnitOfWork: async <TResult>(_scope: typeof scope, operation: () => Promise<TResult>) => await operation(),
      getScopeContext: (currentScope: typeof scope) => ({
        scope_id: currentScope.projectId,
        role_session_map: currentScope.roleSessionMap
      }),
      getSession: async (_scope: typeof scope, sessionId: string) => (session.sessionId === sessionId ? session : null),
      touchSession: async (_scope: typeof scope, _sessionId: string, patch: Record<string, unknown>) => {
        session = { ...session, ...patch };
        return session;
      },
      appendEvent: async (
        _scope: typeof scope,
        eventType:
          | "SESSION_RETRY_DISPATCH_REQUESTED"
          | "SESSION_RETRY_DISPATCH_ACCEPTED"
          | "SESSION_RETRY_DISPATCH_REJECTED",
        _session: SessionRecord,
        payload: Record<string, unknown>
      ) => {
        events.push({ type: eventType, payload });
        return { eventId: `event-${events.length}` };
      },
      dispatch: async (_scope: typeof scope, activeSession: SessionRecord) => {
        dispatches.push({ scopeId: scope.projectId, sessionId: activeSession.sessionId });
        return {
          accepted: options.dispatchAccepted !== false,
          dispatch_scope: activeSession.currentTaskId ? "task" : "role",
          reason: options.dispatchReason
        } as const;
      },
      resetReminder: async () => {
        reminderResets += 1;
      }
    }
  };
}

test("retryProjectDispatchSession accepts guarded retry, clears failure context, and writes requested/accepted audit events", async () => {
  const fixture = buildOperations(createSession());

  const result = await retryProjectDispatchSession(
    {
      scope_kind: "project",
      scope_id: "project-alpha",
      session_id: "session-dev",
      actor: "dashboard",
      reason: "manual_retry",
      confirm: false,
      expected_status: "idle",
      expected_role_mapping: "authoritative",
      expected_current_task_id: "task-a",
      expected_last_failure_at: "2026-04-20T10:00:00.000Z",
      expected_last_failure_event_id: "evt-failure",
      expected_last_failure_task_id: "task-a"
    },
    fixture.operations
  );

  assert.equal(result.accepted, true);
  assert.equal(result.dispatch_scope, "task");
  assert.deepEqual(
    fixture.events.map((event) => event.type),
    ["SESSION_RETRY_DISPATCH_REQUESTED", "SESSION_RETRY_DISPATCH_ACCEPTED"]
  );
  assert.equal(fixture.dispatches.length, 1);
  assert.equal(fixture.session.lastFailureAt, null);
  assert.equal(fixture.session.lastFailureKind, null);
  assert.equal(fixture.session.lastFailureEventId, null);
  assert.equal(fixture.session.lastFailureTaskId, null);
  assert.equal(fixture.session.cooldownUntil ?? null, null);
  assert.equal(fixture.reminderResets, 1);
});

test("retryProjectDispatchSession rejects optimistic-guard mismatches and records requested/rejected audit events", async () => {
  const fixture = buildOperations(createSession());

  await assert.rejects(
    retryProjectDispatchSession(
      {
        scope_kind: "project",
        scope_id: "project-alpha",
        session_id: "session-dev",
        actor: "dashboard",
        reason: "manual_retry",
        confirm: false,
        expected_status: "idle",
        expected_role_mapping: "authoritative",
        expected_current_task_id: "task-other",
        expected_last_failure_at: "2026-04-20T10:00:00.000Z",
        expected_last_failure_event_id: "evt-failure",
        expected_last_failure_task_id: "task-a"
      },
      fixture.operations
    ),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      const candidate = error as {
        status?: number;
        payload?: { code?: string; disabled_reason?: string | null };
      };
      assert.equal(candidate.status, 409);
      assert.equal(candidate.payload?.code, "SESSION_RETRY_DISPATCH_NOT_ALLOWED");
      assert.equal(candidate.payload?.disabled_reason, "current task changed");
      return true;
    }
  );

  assert.deepEqual(
    fixture.events.map((event) => event.type),
    ["SESSION_RETRY_DISPATCH_REQUESTED", "SESSION_RETRY_DISPATCH_REJECTED"]
  );
  assert.equal(fixture.dispatches.length, 0);
  assert.equal(fixture.reminderResets, 0);
});

test("retryProjectDispatchSession records rejection when orchestrator refuses the retry", async () => {
  const fixture = buildOperations(createSession(), {
    dispatchAccepted: false,
    dispatchReason: "Dispatch was not accepted for this session."
  });

  await assert.rejects(
    retryProjectDispatchSession(
      {
        scope_kind: "project",
        scope_id: "project-alpha",
        session_id: "session-dev",
        actor: "dashboard",
        reason: "manual_retry",
        confirm: false,
        expected_status: "idle",
        expected_role_mapping: "authoritative",
        expected_current_task_id: "task-a",
        expected_last_failure_at: "2026-04-20T10:00:00.000Z",
        expected_last_failure_event_id: "evt-failure",
        expected_last_failure_task_id: "task-a"
      },
      fixture.operations
    ),
    (error: unknown) => {
      assert.equal(typeof error, "object");
      const candidate = error as {
        status?: number;
        payload?: { code?: string; disabled_reason?: string | null };
      };
      assert.equal(candidate.status, 409);
      assert.equal(candidate.payload?.code, "SESSION_RETRY_DISPATCH_NOT_ALLOWED");
      assert.equal(candidate.payload?.disabled_reason, "Dispatch was not accepted for this session.");
      return true;
    }
  );

  assert.deepEqual(
    fixture.events.map((event) => event.type),
    ["SESSION_RETRY_DISPATCH_REQUESTED", "SESSION_RETRY_DISPATCH_REJECTED"]
  );
  assert.equal(fixture.dispatches.length, 1);
  assert.equal(fixture.reminderResets, 0);
});
