import type { ReminderMode, RoleRuntimeState } from "../../domain/models.js";

export interface ReminderCalculationOptions {
  initialWaitMs?: number;
  backoffMultiplier?: number;
  maxWaitMs?: number;
}

export function normalizeReminderMode(raw: ReminderMode | undefined): ReminderMode {
  return raw === "fixed_interval" ? "fixed_interval" : "backoff";
}

/**
 * Calculate next reminder time using exponential backoff.
 * Formula: nextReminderAt = now + min(initialWaitMs * (backoffMultiplier ^ reminderCount), maxWaitMs)
 */
export function calculateNextReminderTime(
  reminderCount: number,
  nowMs: number = Date.now(),
  options?: ReminderCalculationOptions
): string {
  const initialWaitMs = options?.initialWaitMs ?? 60000;
  const backoffMultiplier = options?.backoffMultiplier ?? 2;
  const maxWaitMs = options?.maxWaitMs ?? 1800000;
  const waitMs = Math.min(initialWaitMs * Math.pow(backoffMultiplier, reminderCount), maxWaitMs);
  return new Date(nowMs + waitMs).toISOString();
}

export function calculateNextReminderTimeByMode(
  reminderMode: ReminderMode,
  reminderCount: number,
  nowMs: number,
  options?: ReminderCalculationOptions
): string {
  if (reminderMode === "fixed_interval") {
    const intervalMs = options?.initialWaitMs ?? 60000;
    return new Date(nowMs + intervalMs).toISOString();
  }
  return calculateNextReminderTime(reminderCount, nowMs, options);
}

export function shouldAutoResetReminderOnRoleTransition(
  previousState: RoleRuntimeState,
  currentState: RoleRuntimeState
): boolean {
  return previousState === "INACTIVE" && currentState === "IDLE";
}
