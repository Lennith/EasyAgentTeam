import type express from "express";
import type { RecoveryActionRejection } from "../../services/runtime-recovery-action-policy.js";
import { MAX_RECOVERY_ATTEMPT_LIMIT, type RecoveryAttemptLimit } from "../../services/runtime-recovery-attempts.js";
import type { RetryDispatchGuardInput } from "../../services/runtime-retry-dispatch-service.js";
import { sendApiError } from "./http.js";

export interface RecoveryAttemptLimitReadResult {
  attempt_limit?: RecoveryAttemptLimit;
  error?: {
    code: string;
    message: string;
    next_action: string;
  };
}

export function readRecoveryConfirm(body: Record<string, unknown>): boolean {
  return body.confirm === true;
}

export function readRecoveryActor(body: Record<string, unknown>): "dashboard" | "api" {
  return body.actor === "dashboard" ? "dashboard" : "api";
}

function readOptionalString(body: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) {
      continue;
    }
    const value = body[key];
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function readSingleQueryString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0].trim();
  }
  return undefined;
}

export function readRecoveryAttemptLimit(
  value: unknown,
  options: { allow_all?: boolean } = {}
): RecoveryAttemptLimitReadResult {
  const raw = readSingleQueryString(value);
  if (!raw) {
    return {};
  }
  if (raw === "all") {
    if (options.allow_all === false) {
      return {
        error: {
          code: "INVALID_RECOVERY_ATTEMPT_LIMIT",
          message: "attempt_limit=all is only supported by the session recovery-attempts detail endpoint",
          next_action:
            "Use a positive attempt_limit for runtime-recovery, or call /sessions/:session_id/recovery-attempts?attempt_limit=all."
        }
      };
    }
    return { attempt_limit: "all" };
  }
  if (/^[1-9]\d*$/.test(raw)) {
    const limit = Number.parseInt(raw, 10);
    if (limit <= MAX_RECOVERY_ATTEMPT_LIMIT) {
      return { attempt_limit: limit };
    }
  }
  return {
    error: {
      code: "INVALID_RECOVERY_ATTEMPT_LIMIT",
      message: `attempt_limit must be a positive integer up to ${MAX_RECOVERY_ATTEMPT_LIMIT} or 'all'`,
      next_action:
        options.allow_all === false
          ? "Use attempt_limit=5 for dashboard views or call the session recovery-attempts endpoint for full history."
          : "Use attempt_limit=5 for dashboard views or attempt_limit=all for full recovery history."
    }
  };
}

export function readRetryDispatchGuards(body: Record<string, unknown>): RetryDispatchGuardInput {
  return {
    expected_status: readOptionalString(body, ["expected_status", "expectedStatus"]),
    expected_role_mapping: readOptionalString(body, [
      "expected_role_mapping",
      "expectedRoleMapping"
    ]) as RetryDispatchGuardInput["expected_role_mapping"],
    expected_current_task_id: readOptionalString(body, ["expected_current_task_id", "expectedCurrentTaskId"]),
    expected_last_failure_at: readOptionalString(body, ["expected_last_failure_at", "expectedLastFailureAt"]),
    expected_last_failure_event_id: readOptionalString(body, [
      "expected_last_failure_event_id",
      "expectedLastFailureEventId"
    ]),
    expected_last_failure_dispatch_id: readOptionalString(body, [
      "expected_last_failure_dispatch_id",
      "expectedLastFailureDispatchId"
    ]),
    expected_last_failure_message_id: readOptionalString(body, [
      "expected_last_failure_message_id",
      "expectedLastFailureMessageId"
    ]),
    expected_last_failure_task_id: readOptionalString(body, [
      "expected_last_failure_task_id",
      "expectedLastFailureTaskId"
    ])
  };
}

export function sendRecoveryRejection(res: express.Response, status: number, rejection: RecoveryActionRejection): void {
  sendApiError(res, status, rejection.code, rejection.message, rejection.next_action, {
    code: rejection.code,
    disabled_reason: rejection.disabled_reason,
    risk: rejection.risk,
    details: rejection.details
  });
}
