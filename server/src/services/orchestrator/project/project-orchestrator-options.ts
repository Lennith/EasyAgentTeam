import type { ProviderRegistry } from "../../provider-runtime.js";
import type { OrchestratorOptions } from "./project-orchestrator-types.js";
import {
  resolveBooleanEnvFlag,
  resolveIntegerEnvValue,
  resolveNumberEnvValue,
  type OrchestratorEnvSource
} from "../shared/orchestrator-env.js";

export function resolveProjectOrchestratorOptionsFromEnv(
  dataRoot: string,
  providerRegistry: ProviderRegistry,
  env: OrchestratorEnvSource = process.env
): OrchestratorOptions {
  return {
    dataRoot,
    providerRegistry,
    enabled: resolveBooleanEnvFlag(["ORCHESTRATOR_ENABLED"], true, env),
    intervalMs: resolveIntegerEnvValue(["ORCHESTRATOR_INTERVAL_MS"], 10000, (value) => value > 500, env),
    maxConcurrentDispatches: resolveIntegerEnvValue(
      ["ORCHESTRATOR_MAX_CONCURRENT_SESSIONS"],
      2,
      (value) => value > 0,
      env
    ),
    sessionRunningTimeoutMs: resolveIntegerEnvValue(["SESSION_RUNNING_TIMEOUT_MS"], 60000, (value) => value > 0, env),
    idleTimeoutMs: resolveIntegerEnvValue(["ORCHESTRATOR_IDLE_TIMEOUT_MS"], 60000, (value) => value > 0, env),
    reminderBackoffMultiplier: resolveNumberEnvValue(
      ["ORCHESTRATOR_REMINDER_BACKOFF_MULTIPLIER"],
      2,
      (value) => value > 1,
      env
    ),
    reminderMaxIntervalMs: resolveIntegerEnvValue(
      ["ORCHESTRATOR_REMINDER_MAX_INTERVAL_MS"],
      1800000,
      (value) => value > 0,
      env
    ),
    reminderMaxCount: resolveIntegerEnvValue(["ORCHESTRATOR_REMINDER_MAX_COUNT"], 5, (value) => value >= 0, env),
    autoReminderEnabled: resolveBooleanEnvFlag(["ORCHESTRATOR_AUTO_REMINDER_ENABLED"], true, env)
  };
}
