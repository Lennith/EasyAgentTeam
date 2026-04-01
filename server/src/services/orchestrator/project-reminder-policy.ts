import type { ReminderMode, RoleRuntimeState } from "../../domain/models.js";

export interface ReminderCalculationOptions {
  initialWaitMs?: number;
  backoffMultiplier?: number;
  maxWaitMs?: number;
}

export interface ReminderEligibilityInput {
  currentRoleState: RoleRuntimeState;
  hasIdleSession: boolean;
  hasOpenTask: boolean;
  reminderCount: number;
  maxRetries: number;
  idleSince?: string;
  nextReminderAt?: string;
  nowMs: number;
}

export function normalizeReminderMode(raw: ReminderMode | undefined): ReminderMode {
  return raw === "fixed_interval" ? "fixed_interval" : "backoff";
}

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

export function evaluateReminderEligibility(input: ReminderEligibilityInput): {
  eligible: boolean;
  reason:
    | "skip_non_idle_state"
    | "skip_missing_idle_session"
    | "skip_no_open_task"
    | "max_retries_reached"
    | "skip_missing_idle_since"
    | "schedule_missing_next_reminder"
    | "waiting_for_next_reminder"
    | "trigger";
} {
  if (input.currentRoleState !== "IDLE") {
    return { eligible: false, reason: "skip_non_idle_state" };
  }
  if (!input.hasIdleSession) {
    return { eligible: false, reason: "skip_missing_idle_session" };
  }
  if (!input.hasOpenTask) {
    return { eligible: false, reason: "skip_no_open_task" };
  }
  if (input.reminderCount >= input.maxRetries) {
    return { eligible: false, reason: "max_retries_reached" };
  }
  if (!input.idleSince) {
    return { eligible: false, reason: "skip_missing_idle_since" };
  }
  const nextReminderTime = input.nextReminderAt ? Date.parse(input.nextReminderAt) : Number.NaN;
  if (!Number.isFinite(nextReminderTime)) {
    return { eligible: false, reason: "schedule_missing_next_reminder" };
  }
  if (input.nowMs < nextReminderTime) {
    return { eligible: false, reason: "waiting_for_next_reminder" };
  }
  return { eligible: true, reason: "trigger" };
}
