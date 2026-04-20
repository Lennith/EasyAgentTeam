import type express from "express";
import type { RecoveryActionRejection } from "../../services/runtime-recovery-action-policy.js";
import { sendApiError } from "./http.js";

export function readRecoveryConfirm(body: Record<string, unknown>): boolean {
  return body.confirm === true;
}

export function readRecoveryActor(body: Record<string, unknown>): "dashboard" | "api" {
  return body.actor === "dashboard" ? "dashboard" : "api";
}

export function sendRecoveryRejection(res: express.Response, status: number, rejection: RecoveryActionRejection): void {
  sendApiError(res, status, rejection.code, rejection.message, rejection.next_action, {
    code: rejection.code,
    disabled_reason: rejection.disabled_reason,
    risk: rejection.risk,
    details: rejection.details
  });
}
