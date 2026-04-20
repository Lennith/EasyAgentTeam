import type { RecoveryActionRejection } from "./runtime-recovery-action-policy.js";

export class RecoveryCommandError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: RecoveryActionRejection
  ) {
    super(payload.message);
  }
}

export function isRecoveryCommandError(error: unknown): error is RecoveryCommandError {
  return error instanceof RecoveryCommandError;
}
