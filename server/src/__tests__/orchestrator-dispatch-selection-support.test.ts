import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOrchestratorDuplicateTaskDispatchSkipResult,
  evaluateOrchestratorDispatchSessionAvailability,
  guardOrchestratorDuplicateTaskDispatch
} from "../services/orchestrator/shared/dispatch-selection-support.js";

test("dispatch selection support blocks non-idle session when onlyIdle is enabled", () => {
  const result = evaluateOrchestratorDispatchSessionAvailability({
    sessionStatus: "running",
    onlyIdle: true,
    force: false
  });
  assert.equal(result.available, false);
  assert.equal(result.busy, true);
  assert.equal(result.reason, "session status is running");
});

test("dispatch selection support blocks in-flight session when force is disabled", () => {
  const result = evaluateOrchestratorDispatchSessionAvailability({
    sessionStatus: "idle",
    onlyIdle: false,
    force: false,
    hasInFlightDispatch: true
  });
  assert.equal(result.available, false);
  assert.equal(result.busy, true);
  assert.equal(result.reason, "session already dispatching");
});

test("dispatch selection support blocks cooldown session", () => {
  const cooldown = "2099-03-29T00:00:00.000Z";
  const result = evaluateOrchestratorDispatchSessionAvailability({
    sessionStatus: "idle",
    onlyIdle: false,
    force: false,
    cooldownUntil: cooldown,
    nowMs: Date.parse("2026-03-29T00:00:00.000Z")
  });
  assert.equal(result.available, false);
  assert.equal(result.busy, true);
  assert.equal(result.reason, `session cooldown active until ${cooldown}`);
});

test("dispatch selection support blocks blocked session when force is disabled", () => {
  const result = evaluateOrchestratorDispatchSessionAvailability({
    sessionStatus: "blocked",
    onlyIdle: false,
    force: false
  });
  assert.equal(result.available, false);
  assert.equal(result.busy, true);
  assert.equal(result.reason, "session status is blocked");
});

test("dispatch selection support allows running session when running gate is disabled", () => {
  const result = evaluateOrchestratorDispatchSessionAvailability({
    sessionStatus: "running",
    onlyIdle: false,
    force: false,
    treatRunningAsBusy: false
  });
  assert.equal(result.available, true);
  assert.equal(result.busy, false);
});

test("duplicate dispatch guard returns true and triggers callback on open task dispatch", async () => {
  let callbackCount = 0;
  const duplicate = await guardOrchestratorDuplicateTaskDispatch({
    taskId: "task_a",
    sessionId: "session_a",
    listEvents: async () => [
      {
        eventType: "ORCHESTRATOR_DISPATCH_STARTED",
        createdAt: "2026-03-29T00:00:00.000Z",
        taskId: "task_a",
        sessionId: "session_a",
        payload: {
          dispatchId: "dispatch_1",
          dispatchKind: "task"
        }
      }
    ],
    onDuplicateDetected: async () => {
      callbackCount += 1;
    }
  });
  assert.equal(duplicate, true);
  assert.equal(callbackCount, 1);
});

test("duplicate dispatch guard returns false when task dispatch is already closed", async () => {
  let callbackCount = 0;
  const duplicate = await guardOrchestratorDuplicateTaskDispatch({
    taskId: "task_a",
    sessionId: "session_a",
    listEvents: async () => [
      {
        eventType: "ORCHESTRATOR_DISPATCH_STARTED",
        createdAt: "2026-03-29T00:00:00.000Z",
        taskId: "task_a",
        sessionId: "session_a",
        payload: {
          dispatchId: "dispatch_1",
          dispatchKind: "task"
        }
      },
      {
        eventType: "ORCHESTRATOR_DISPATCH_FINISHED",
        createdAt: "2026-03-29T00:00:01.000Z",
        taskId: "task_a",
        sessionId: "session_a",
        payload: {
          dispatchId: "dispatch_1",
          dispatchKind: "task"
        }
      }
    ],
    onDuplicateDetected: async () => {
      callbackCount += 1;
    }
  });
  assert.equal(duplicate, false);
  assert.equal(callbackCount, 0);
});

test("duplicate dispatch skip helper returns built result only when duplicate is found", async () => {
  const skipped = await buildOrchestratorDuplicateTaskDispatchSkipResult({
    taskId: "task_a",
    sessionId: "session_a",
    listEvents: async () => [
      {
        eventType: "ORCHESTRATOR_DISPATCH_STARTED",
        createdAt: "2026-03-29T00:00:00.000Z",
        taskId: "task_a",
        sessionId: "session_a",
        payload: { dispatchId: "dispatch_1", dispatchKind: "task" }
      }
    ],
    buildSkippedResult: () => ({
      outcome: "already_dispatched",
      reason: "duplicate_open_dispatch"
    })
  });
  assert.deepEqual(skipped, {
    outcome: "already_dispatched",
    reason: "duplicate_open_dispatch"
  });

  const notSkipped = await buildOrchestratorDuplicateTaskDispatchSkipResult({
    taskId: "task_a",
    sessionId: "session_a",
    listEvents: async () => [
      {
        eventType: "ORCHESTRATOR_DISPATCH_STARTED",
        createdAt: "2026-03-29T00:00:00.000Z",
        taskId: "task_a",
        sessionId: "session_a",
        payload: { dispatchId: "dispatch_1", dispatchKind: "task" }
      },
      {
        eventType: "ORCHESTRATOR_DISPATCH_FINISHED",
        createdAt: "2026-03-29T00:00:01.000Z",
        taskId: "task_a",
        sessionId: "session_a",
        payload: { dispatchId: "dispatch_1", dispatchKind: "task" }
      }
    ],
    buildSkippedResult: () => ({
      outcome: "already_dispatched",
      reason: "duplicate_open_dispatch"
    })
  });
  assert.equal(notSkipped, null);
});
