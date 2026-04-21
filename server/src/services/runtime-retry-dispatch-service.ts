import { randomUUID } from "node:crypto";
import type { SessionRecord, WorkflowSessionRecord } from "../domain/models.js";
import {
  buildRecoveryActionRejection,
  buildRecoveryConfirmationRequired,
  type RecoveryMappingState,
  type RecoveryRetryDispatchResult
} from "./runtime-recovery-action-policy.js";
import { RecoveryCommandError } from "./runtime-recovery-command-error.js";
import { buildRecoveryPolicyContext, type RecoveryPolicySessionLike } from "./runtime-recovery-policy-context.js";

type RetryDispatchSession = RecoveryPolicySessionLike &
  Pick<SessionRecord, "provider" | "providerSessionId" | "lastFailureAt" | "lastFailureKind"> & {
    lastFailureEventId?: string | null;
    lastFailureDispatchId?: string | null;
    lastFailureMessageId?: string | null;
    lastFailureTaskId?: string | null;
  };

export interface RetryDispatchGuardInput {
  expected_status?: string;
  expected_role_mapping?: RecoveryMappingState;
  expected_current_task_id?: string | null;
  expected_last_failure_at?: string | null;
  expected_last_failure_event_id?: string | null;
  expected_last_failure_dispatch_id?: string | null;
  expected_last_failure_message_id?: string | null;
  expected_last_failure_task_id?: string | null;
}

export interface RetryDispatchCommandInput extends RetryDispatchGuardInput {
  scope_kind: "project" | "workflow";
  scope_id: string;
  session_id: string;
  actor: "dashboard" | "api";
  reason: string;
  confirm: boolean;
}

interface RetryDispatchExecutionResult {
  accepted: boolean;
  dispatch_scope: "task" | "role";
  reason?: string;
}

interface RetryDispatchExecutionOptions {
  recovery_attempt_id: string;
}

interface RetryDispatchScope<TSession extends RetryDispatchSession> {
  scope_id: string;
  role_session_map?: Record<string, string>;
}

interface RetryDispatchServiceOperations<TScope, TSession extends RetryDispatchSession> {
  loadScope(scopeId: string): Promise<TScope>;
  runInUnitOfWork<TResult>(scope: TScope, operation: () => Promise<TResult>): Promise<TResult>;
  getScopeContext(scope: TScope): RetryDispatchScope<TSession>;
  getSession(scope: TScope, sessionId: string): Promise<TSession | null>;
  touchSession(
    scope: TScope,
    sessionId: string,
    patch: {
      lastFailureAt?: string | null;
      lastFailureKind?: "timeout" | "error" | null;
      lastFailureEventId?: string | null;
      lastFailureDispatchId?: string | null;
      lastFailureMessageId?: string | null;
      lastFailureTaskId?: string | null;
      cooldownUntil?: string | null;
    }
  ): Promise<TSession>;
  appendEvent(
    scope: TScope,
    eventType:
      | "SESSION_RETRY_DISPATCH_REQUESTED"
      | "SESSION_RETRY_DISPATCH_ACCEPTED"
      | "SESSION_RETRY_DISPATCH_REJECTED",
    session: TSession,
    payload: Record<string, unknown>
  ): Promise<{ eventId?: string } | void>;
  dispatch(
    scope: TScope,
    session: TSession,
    options: RetryDispatchExecutionOptions
  ): Promise<RetryDispatchExecutionResult>;
  resetReminder(scope: TScope, role: string): Promise<void>;
}

function buildRetryDispatchNotAllowed(
  sessionId: string,
  policyInput: ReturnType<typeof buildRecoveryPolicyContext>["input"],
  policy: ReturnType<typeof buildRecoveryPolicyContext>["policy"],
  reason: string
) {
  return {
    ...buildRecoveryActionRejection(
      sessionId,
      "retry_dispatch",
      policyInput,
      policy,
      "SESSION_RETRY_DISPATCH_NOT_ALLOWED"
    ),
    message: `retry dispatch is not allowed for session '${sessionId}'`,
    next_action: "Wait until the session is idle and the recovery context is still valid, then retry dispatch again.",
    disabled_reason: reason || policy.disabled_reason,
    risk: policy.risk
  } as const;
}

function normalizeNullable(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildRetryDispatchGuardRequired(sessionId: string, disabledReason: string, details: Record<string, unknown>) {
  return {
    code: "SESSION_RETRY_GUARD_REQUIRED",
    message: `retry dispatch requires optimistic guard fields for session '${sessionId}'`,
    next_action:
      "Refresh Recovery Center and retry with expected_status, expected_role_mapping, and failure context guard.",
    disabled_reason: disabledReason,
    risk: null,
    details
  } as const;
}

function resolveGuardRequirementFailure(
  input: RetryDispatchCommandInput,
  session: RetryDispatchSession
): { disabled_reason: string; details: Record<string, unknown> } | null {
  const issues: string[] = [];
  const required_fields = ["expected_status", "expected_role_mapping"] as string[];

  if (input.expected_status !== "idle") {
    issues.push("expected_status must be provided as 'idle'");
  }
  if (input.expected_role_mapping !== "authoritative") {
    issues.push("expected_role_mapping must be provided as 'authoritative'");
  }

  const expectedFailureEventId = normalizeNullable(input.expected_last_failure_event_id);
  const expectedFailureDispatchId = normalizeNullable(input.expected_last_failure_dispatch_id);
  if (!expectedFailureEventId && !expectedFailureDispatchId) {
    required_fields.push("expected_last_failure_event_id|expected_last_failure_dispatch_id");
    issues.push("one of expected_last_failure_event_id or expected_last_failure_dispatch_id is required");
  }

  if (session.currentTaskId) {
    required_fields.push("expected_current_task_id");
    if (!normalizeNullable(input.expected_current_task_id)) {
      issues.push("expected_current_task_id is required while the session still has currentTaskId");
    }
  }

  if (issues.length === 0) {
    return null;
  }

  return {
    disabled_reason: issues.join("; "),
    details: {
      action: "retry_dispatch",
      session_id: session.sessionId,
      required_fields,
      current_task_id: session.currentTaskId ?? null,
      current_task_guard_required: Boolean(session.currentTaskId)
    }
  };
}

function resolveGuardMismatch(
  input: RetryDispatchCommandInput,
  actual: ReturnType<typeof buildRecoveryPolicyContext>["input"],
  session: RetryDispatchSession
): string | null {
  const expectedPairs: Array<[string | undefined | null, string | null, string]> = [
    [input.expected_status, actual.session_status ?? null, "session status changed"],
    [input.expected_role_mapping ?? null, actual.role_session_mapping ?? null, "role mapping changed"],
    [normalizeNullable(input.expected_current_task_id), actual.current_task_id ?? null, "current task changed"],
    [
      normalizeNullable(input.expected_last_failure_at),
      session.lastFailureAt ?? null,
      "last failure timestamp changed"
    ],
    [
      normalizeNullable(input.expected_last_failure_event_id),
      session.lastFailureEventId ?? null,
      "failure event changed"
    ],
    [
      normalizeNullable(input.expected_last_failure_dispatch_id),
      session.lastFailureDispatchId ?? null,
      "failure dispatch changed"
    ],
    [
      normalizeNullable(input.expected_last_failure_message_id),
      session.lastFailureMessageId ?? null,
      "failure message changed"
    ],
    [normalizeNullable(input.expected_last_failure_task_id), session.lastFailureTaskId ?? null, "failure task changed"]
  ];

  for (const [expected, actualValue, message] of expectedPairs) {
    if (expected === undefined) {
      continue;
    }
    if ((expected ?? null) !== (actualValue ?? null)) {
      return message;
    }
  }
  return null;
}

function buildAuditPayload(
  input: RetryDispatchCommandInput,
  session: RetryDispatchSession,
  dispatchScope: "task" | "role",
  recoveryAttemptId: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    actor: input.actor,
    reason: input.reason,
    recovery_attempt_id: recoveryAttemptId,
    session_id: session.sessionId,
    current_task_id: session.currentTaskId ?? null,
    dispatch_scope: dispatchScope,
    confirm: input.confirm,
    expected_status: input.expected_status ?? null,
    expected_role_mapping: input.expected_role_mapping ?? null,
    expected_current_task_id: normalizeNullable(input.expected_current_task_id),
    expected_last_failure_at: normalizeNullable(input.expected_last_failure_at),
    expected_last_failure_event_id: normalizeNullable(input.expected_last_failure_event_id),
    expected_last_failure_dispatch_id: normalizeNullable(input.expected_last_failure_dispatch_id),
    expected_last_failure_message_id: normalizeNullable(input.expected_last_failure_message_id),
    expected_last_failure_task_id: normalizeNullable(input.expected_last_failure_task_id),
    ...extra
  };
}

async function executeRetryDispatchCommand<TScope, TSession extends RetryDispatchSession>(
  input: RetryDispatchCommandInput,
  operations: RetryDispatchServiceOperations<TScope, TSession>
): Promise<RecoveryRetryDispatchResult<TSession>> {
  const scope = await operations.loadScope(input.scope_id);
  return await operations.runInUnitOfWork(scope, async () => {
    const session = await operations.getSession(scope, input.session_id);
    if (!session) {
      throw new Error(`session '${input.session_id}' not found`);
    }
    const scopeContext = operations.getScopeContext(scope);
    const contextResult = buildRecoveryPolicyContext({
      scope_kind: input.scope_kind,
      session,
      role_session_map: scopeContext.role_session_map,
      last_failure_kind: session.lastFailureKind ?? null,
      provider_session_id: session.providerSessionId ?? null
    });
    const dispatchScope = session.currentTaskId ? "task" : "role";
    const recoveryAttemptId = randomUUID();

    await operations.appendEvent(
      scope,
      "SESSION_RETRY_DISPATCH_REQUESTED",
      session,
      buildAuditPayload(input, session, dispatchScope, recoveryAttemptId)
    );

    const guardRequirementFailure = resolveGuardRequirementFailure(input, session);
    if (guardRequirementFailure) {
      await operations.appendEvent(
        scope,
        "SESSION_RETRY_DISPATCH_REJECTED",
        session,
        buildAuditPayload(input, session, dispatchScope, recoveryAttemptId, {
          rejection_code: "SESSION_RETRY_GUARD_REQUIRED",
          rejection_reason: guardRequirementFailure.disabled_reason
        })
      );
      throw new RecoveryCommandError(
        409,
        buildRetryDispatchGuardRequired(
          session.sessionId,
          guardRequirementFailure.disabled_reason,
          guardRequirementFailure.details
        )
      );
    }

    if (!contextResult.policy.can_retry_dispatch) {
      await operations.appendEvent(
        scope,
        "SESSION_RETRY_DISPATCH_REJECTED",
        session,
        buildAuditPayload(input, session, dispatchScope, recoveryAttemptId, {
          rejection_code: "SESSION_RETRY_DISPATCH_NOT_ALLOWED",
          rejection_reason: contextResult.policy.disabled_reason ?? "Retry dispatch is not allowed for this session."
        })
      );
      throw new RecoveryCommandError(
        409,
        buildRetryDispatchNotAllowed(
          session.sessionId,
          contextResult.input,
          contextResult.policy,
          contextResult.policy.disabled_reason ?? "Retry dispatch is not allowed for this session."
        )
      );
    }

    if (contextResult.policy.requires_confirmation && !input.confirm) {
      await operations.appendEvent(
        scope,
        "SESSION_RETRY_DISPATCH_REJECTED",
        session,
        buildAuditPayload(input, session, dispatchScope, recoveryAttemptId, {
          rejection_code: "SESSION_RECOVERY_CONFIRMATION_REQUIRED",
          rejection_reason: "confirmation_required"
        })
      );
      throw new RecoveryCommandError(
        409,
        buildRecoveryConfirmationRequired(
          session.sessionId,
          "retry_dispatch",
          contextResult.input,
          contextResult.policy
        )
      );
    }

    const mismatchReason = resolveGuardMismatch(input, contextResult.input, session);
    if (mismatchReason) {
      await operations.appendEvent(
        scope,
        "SESSION_RETRY_DISPATCH_REJECTED",
        session,
        buildAuditPayload(input, session, dispatchScope, recoveryAttemptId, {
          rejection_code: "SESSION_RETRY_DISPATCH_NOT_ALLOWED",
          rejection_reason: mismatchReason
        })
      );
      throw new RecoveryCommandError(
        409,
        buildRetryDispatchNotAllowed(session.sessionId, contextResult.input, contextResult.policy, mismatchReason)
      );
    }

    const dispatchResult = await operations.dispatch(scope, session, {
      recovery_attempt_id: recoveryAttemptId
    });
    if (!dispatchResult.accepted) {
      const rejectionReason = dispatchResult.reason ?? "Retry dispatch was not accepted by the orchestrator.";
      await operations.appendEvent(
        scope,
        "SESSION_RETRY_DISPATCH_REJECTED",
        session,
        buildAuditPayload(input, session, dispatchResult.dispatch_scope, recoveryAttemptId, {
          rejection_code: "SESSION_RETRY_DISPATCH_NOT_ALLOWED",
          rejection_reason: rejectionReason
        })
      );
      throw new RecoveryCommandError(
        409,
        buildRetryDispatchNotAllowed(session.sessionId, contextResult.input, contextResult.policy, rejectionReason)
      );
    }

    const cleared = await operations.touchSession(scope, session.sessionId, {
      lastFailureAt: null,
      lastFailureKind: null,
      lastFailureEventId: null,
      lastFailureDispatchId: null,
      lastFailureMessageId: null,
      lastFailureTaskId: null,
      cooldownUntil: null
    });
    await operations.appendEvent(
      scope,
      "SESSION_RETRY_DISPATCH_ACCEPTED",
      cleared,
      buildAuditPayload(input, cleared, dispatchResult.dispatch_scope, recoveryAttemptId, {
        accepted: true
      })
    );
    await operations.resetReminder(scope, session.role);
    return {
      action: "retry_dispatch",
      session: cleared,
      current_task_id: cleared.currentTaskId ?? null,
      dispatch_scope: dispatchResult.dispatch_scope,
      accepted: true,
      warnings: []
    };
  });
}

export async function retryProjectDispatchSession<TScope>(
  input: RetryDispatchCommandInput,
  operations: RetryDispatchServiceOperations<TScope, SessionRecord>
): Promise<RecoveryRetryDispatchResult<SessionRecord>> {
  return await executeRetryDispatchCommand(input, operations);
}

export async function retryWorkflowDispatchSession<TScope>(
  input: RetryDispatchCommandInput,
  operations: RetryDispatchServiceOperations<TScope, WorkflowSessionRecord>
): Promise<RecoveryRetryDispatchResult<WorkflowSessionRecord>> {
  return await executeRetryDispatchCommand(input, operations);
}
