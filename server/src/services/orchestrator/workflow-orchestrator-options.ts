import {
  resolveBooleanEnvFlag,
  resolveIntegerEnvValue,
  resolveNumberEnvValue,
  type OrchestratorEnvSource
} from "./shared/orchestrator-env.js";

export interface WorkflowOrchestratorOptions {
  enabled?: boolean;
  intervalMs?: number;
  maxConcurrentDispatches?: number;
  idleReminderMs?: number;
  reminderBackoffMultiplier?: number;
  reminderMaxIntervalMs?: number;
  reminderMaxCount?: number;
  autoReminderEnabled?: boolean;
  sessionRunningTimeoutMs?: number;
}

export type ResolvedWorkflowOrchestratorOptions = Required<WorkflowOrchestratorOptions>;

export function resolveWorkflowOrchestratorOptionsFromEnv(
  env: OrchestratorEnvSource = process.env
): ResolvedWorkflowOrchestratorOptions {
  return {
    enabled: resolveBooleanEnvFlag(["WORKFLOW_ORCHESTRATOR_ENABLED", "ORCHESTRATOR_ENABLED"], true, env),
    intervalMs: resolveIntegerEnvValue(
      ["WORKFLOW_ORCHESTRATOR_INTERVAL_MS", "ORCHESTRATOR_INTERVAL_MS"],
      10000,
      (value) => value > 500,
      env
    ),
    maxConcurrentDispatches: resolveIntegerEnvValue(
      ["WORKFLOW_ORCHESTRATOR_MAX_CONCURRENT_SESSIONS", "ORCHESTRATOR_MAX_CONCURRENT_SESSIONS"],
      2,
      (value) => value > 0,
      env
    ),
    idleReminderMs: resolveIntegerEnvValue(
      ["WORKFLOW_ORCHESTRATOR_IDLE_TIMEOUT_MS", "ORCHESTRATOR_IDLE_TIMEOUT_MS"],
      60000,
      (value) => value > 0,
      env
    ),
    reminderBackoffMultiplier: resolveNumberEnvValue(
      ["WORKFLOW_ORCHESTRATOR_REMINDER_BACKOFF_MULTIPLIER", "ORCHESTRATOR_REMINDER_BACKOFF_MULTIPLIER"],
      2,
      (value) => value > 1,
      env
    ),
    reminderMaxIntervalMs: resolveIntegerEnvValue(
      ["WORKFLOW_ORCHESTRATOR_REMINDER_MAX_INTERVAL_MS", "ORCHESTRATOR_REMINDER_MAX_INTERVAL_MS"],
      1800000,
      (value) => value > 0,
      env
    ),
    reminderMaxCount: resolveIntegerEnvValue(
      ["WORKFLOW_ORCHESTRATOR_REMINDER_MAX_COUNT", "ORCHESTRATOR_REMINDER_MAX_COUNT"],
      5,
      (value) => value >= 0,
      env
    ),
    autoReminderEnabled: resolveBooleanEnvFlag(
      ["WORKFLOW_ORCHESTRATOR_AUTO_REMINDER_ENABLED", "ORCHESTRATOR_AUTO_REMINDER_ENABLED"],
      true,
      env
    ),
    sessionRunningTimeoutMs: resolveIntegerEnvValue(
      ["WORKFLOW_SESSION_RUNNING_TIMEOUT_MS", "SESSION_RUNNING_TIMEOUT_MS"],
      60000,
      (value) => value > 0,
      env
    )
  };
}
