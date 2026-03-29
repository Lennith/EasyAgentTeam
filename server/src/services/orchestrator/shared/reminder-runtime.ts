import type { ReminderMode, RoleRuntimeState } from "../../../domain/models.js";
import {
  calculateNextReminderTimeByMode,
  evaluateReminderEligibility,
  shouldAutoResetReminderOnRoleTransition,
  type ReminderEligibilityInput
} from "../project-reminder-policy.js";

export interface OrchestratorReminderTimingOptions {
  initialWaitMs: number;
  backoffMultiplier: number;
  maxWaitMs: number;
}

export interface BuildOrchestratorReminderRoleStatePatchInput {
  previousRoleState: RoleRuntimeState;
  currentRoleState: RoleRuntimeState;
  reminderMode: ReminderMode;
  reminderCount: number;
  nowMs: number;
  idleSince?: string;
  timing: OrchestratorReminderTimingOptions;
}

export interface BuildOrchestratorReminderSchedulePatchInput {
  reminderMode: ReminderMode;
  reminderCount: number;
  nowMs: number;
  timing: OrchestratorReminderTimingOptions;
}

export interface OrchestratorReminderRoleStatePatch {
  reminderCount?: number;
  idleSince?: string;
  nextReminderAt?: string;
  lastRoleState: RoleRuntimeState;
}

function calculateNextReminderAt(input: BuildOrchestratorReminderSchedulePatchInput): string {
  return calculateNextReminderTimeByMode(input.reminderMode, input.reminderCount, input.nowMs, {
    initialWaitMs: input.timing.initialWaitMs,
    backoffMultiplier: input.timing.backoffMultiplier,
    maxWaitMs: input.timing.maxWaitMs
  });
}

export function buildOrchestratorReminderRoleStatePatch(
  input: BuildOrchestratorReminderRoleStatePatchInput
): OrchestratorReminderRoleStatePatch {
  if (shouldAutoResetReminderOnRoleTransition(input.previousRoleState, input.currentRoleState)) {
    return {
      reminderCount: 0,
      nextReminderAt: calculateNextReminderAt({
        reminderMode: input.reminderMode,
        reminderCount: 0,
        nowMs: input.nowMs,
        timing: input.timing
      }),
      idleSince: input.idleSince,
      lastRoleState: "IDLE"
    };
  }

  if (input.previousRoleState !== "IDLE" && input.currentRoleState === "IDLE") {
    return {
      idleSince: input.idleSince,
      nextReminderAt: calculateNextReminderAt({
        reminderMode: input.reminderMode,
        reminderCount: input.reminderCount,
        nowMs: input.nowMs,
        timing: input.timing
      }),
      lastRoleState: "IDLE"
    };
  }

  if (input.currentRoleState !== "IDLE") {
    return {
      lastRoleState: input.currentRoleState
    };
  }

  return {
    lastRoleState: "IDLE"
  };
}

export function buildOrchestratorReminderSchedulePatch(
  input: BuildOrchestratorReminderSchedulePatchInput
): OrchestratorReminderRoleStatePatch {
  return {
    nextReminderAt: calculateNextReminderAt(input),
    lastRoleState: "IDLE"
  };
}

export function buildOrchestratorReminderTriggeredPatch(
  input: BuildOrchestratorReminderSchedulePatchInput
): OrchestratorReminderRoleStatePatch {
  return {
    reminderCount: input.reminderCount + 1,
    nextReminderAt: calculateNextReminderAt(input),
    lastRoleState: "IDLE"
  };
}

export type OrchestratorReminderEligibilityInput = ReminderEligibilityInput;

export function evaluateOrchestratorReminderEligibility(
  input: OrchestratorReminderEligibilityInput
): ReturnType<typeof evaluateReminderEligibility> {
  return evaluateReminderEligibility(input);
}
