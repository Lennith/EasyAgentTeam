import assert from "node:assert/strict";
import test from "node:test";
import { resolveProjectOrchestratorOptionsFromEnv } from "../services/orchestrator/project-orchestrator-options.js";
import { resolveWorkflowOrchestratorOptionsFromEnv } from "../services/orchestrator/workflow-orchestrator-options.js";

test("project orchestrator options resolve shared env thresholds", () => {
  const options = resolveProjectOrchestratorOptionsFromEnv("C:\\data", {} as any, {
    ORCHESTRATOR_ENABLED: "0",
    ORCHESTRATOR_INTERVAL_MS: "499",
    ORCHESTRATOR_MAX_CONCURRENT_SESSIONS: "7",
    SESSION_RUNNING_TIMEOUT_MS: "45000",
    ORCHESTRATOR_IDLE_TIMEOUT_MS: "0",
    ORCHESTRATOR_REMINDER_BACKOFF_MULTIPLIER: "3.5",
    ORCHESTRATOR_REMINDER_MAX_INTERVAL_MS: "600000",
    ORCHESTRATOR_REMINDER_MAX_COUNT: "6",
    ORCHESTRATOR_AUTO_REMINDER_ENABLED: "0"
  });

  assert.equal(options.enabled, false);
  assert.equal(options.intervalMs, 10000);
  assert.equal(options.maxConcurrentDispatches, 7);
  assert.equal(options.sessionRunningTimeoutMs, 45000);
  assert.equal(options.idleTimeoutMs, 60000);
  assert.equal(options.reminderBackoffMultiplier, 3.5);
  assert.equal(options.reminderMaxIntervalMs, 600000);
  assert.equal(options.reminderMaxCount, 6);
  assert.equal(options.autoReminderEnabled, false);
});

test("workflow orchestrator options keep first-defined env precedence", () => {
  const overridden = resolveWorkflowOrchestratorOptionsFromEnv({
    WORKFLOW_ORCHESTRATOR_INTERVAL_MS: "7500",
    ORCHESTRATOR_INTERVAL_MS: "9000",
    WORKFLOW_ORCHESTRATOR_MAX_CONCURRENT_SESSIONS: "3",
    ORCHESTRATOR_MAX_CONCURRENT_SESSIONS: "5"
  });
  assert.equal(overridden.intervalMs, 7500);
  assert.equal(overridden.maxConcurrentDispatches, 3);

  const invalidWorkflowSpecific = resolveWorkflowOrchestratorOptionsFromEnv({
    WORKFLOW_ORCHESTRATOR_INTERVAL_MS: "invalid",
    ORCHESTRATOR_INTERVAL_MS: "9000",
    WORKFLOW_ORCHESTRATOR_REMINDER_BACKOFF_MULTIPLIER: "invalid",
    ORCHESTRATOR_REMINDER_BACKOFF_MULTIPLIER: "4"
  });
  assert.equal(invalidWorkflowSpecific.intervalMs, 10000);
  assert.equal(invalidWorkflowSpecific.reminderBackoffMultiplier, 2);
});
