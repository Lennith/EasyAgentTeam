import assert from "node:assert/strict";
import test from "node:test";
import {
  countOrchestratorTaskDispatches,
  hasOrchestratorSuccessfulRunFinishEvent,
  isOrchestratorTerminalTaskState,
  isOrchestratorValidProgressContent
} from "../services/orchestrator/shared/completion-policy.js";

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
