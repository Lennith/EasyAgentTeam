import type express from "express";
import type { RecoveryActionRejection } from "../../services/runtime-recovery-action-policy.js";
import type { RetryDispatchGuardInput } from "../../services/runtime-retry-dispatch-service.js";
import { sendApiError } from "./http.js";

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
