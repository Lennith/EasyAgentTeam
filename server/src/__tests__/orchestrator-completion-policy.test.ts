import assert from "node:assert/strict";
import test from "node:test";
import {
  countOrchestratorTaskDispatches,
  hasOrchestratorSuccessfulRunFinishEvent,
  isOrchestratorTerminalTaskState,
  isOrchestratorValidProgressContent,
  resolveOrchestratorMayBeDoneSettings
} from "../services/orchestrator/shared/completion-policy.js";

test("completion policy resolves MAY_BE_DONE settings from env with stable fallback", () => {
  const previousEnabled = process.env.MAY_BE_DONE_ENABLED;
  const previousThreshold = process.env.MAY_BE_DONE_DISPATCH_THRESHOLD;
  const previousWindow = process.env.MAY_BE_DONE_CHECK_WINDOW_MS;
  try {
    process.env.MAY_BE_DONE_ENABLED = "0";
    process.env.MAY_BE_DONE_DISPATCH_THRESHOLD = "not-a-number";
    process.env.MAY_BE_DONE_CHECK_WINDOW_MS = "-1";
    const settings = resolveOrchestratorMayBeDoneSettings();
    assert.deepEqual(settings, {
      enabled: false,
      threshold: 5,
      windowMs: 60 * 60 * 1000
    });
  } finally {
    if (previousEnabled === undefined) delete process.env.MAY_BE_DONE_ENABLED;
    else process.env.MAY_BE_DONE_ENABLED = previousEnabled;
    if (previousThreshold === undefined) delete process.env.MAY_BE_DONE_DISPATCH_THRESHOLD;
    else process.env.MAY_BE_DONE_DISPATCH_THRESHOLD = previousThreshold;
    if (previousWindow === undefined) delete process.env.MAY_BE_DONE_CHECK_WINDOW_MS;
    else process.env.MAY_BE_DONE_CHECK_WINDOW_MS = previousWindow;
  }
});

test("completion policy counts task dispatch starts by taskId and dispatchKind", () => {
  const count = countOrchestratorTaskDispatches("task-1", [
    {
      eventType: "ORCHESTRATOR_DISPATCH_STARTED",
      taskId: "task-1",
      payload: { dispatchKind: "task", dispatchId: "d1" }
    },
    {
      eventType: "ORCHESTRATOR_DISPATCH_STARTED",
      taskId: "task-1",
      payload: { dispatchKind: "message", dispatchId: "d2" }
    },
    {
      eventType: "ORCHESTRATOR_DISPATCH_STARTED",
      taskId: "task-2",
      payload: { dispatchKind: "task", dispatchId: "d3" }
    }
  ]);
  assert.equal(count, 1);
});

test("completion policy detects successful run finish and validates progress content", () => {
  assert.equal(
    hasOrchestratorSuccessfulRunFinishEvent("task-1", [
      {
        eventType: "CODEX_RUN_FINISHED",
        taskId: "task-1",
        payload: { exitCode: 1 }
      },
      {
        eventType: "MINIMAX_RUN_FINISHED",
        taskId: "task-1",
        payload: { exitCode: 0 }
      }
    ]),
    true
  );
  assert.equal(isOrchestratorTerminalTaskState("DONE"), true);
  assert.equal(isOrchestratorTerminalTaskState("CANCELED"), true);
  assert.equal(isOrchestratorTerminalTaskState("IN_PROGRESS"), false);
  assert.equal(isOrchestratorValidProgressContent("short"), false);
  assert.equal(
    isOrchestratorValidProgressContent("This is a sufficiently long and concrete progress update for validation."),
    true
  );
});
