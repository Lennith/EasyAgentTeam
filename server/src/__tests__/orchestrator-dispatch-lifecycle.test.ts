import assert from "node:assert/strict";
import test from "node:test";
import { OrchestratorSingleFlightGate } from "../services/orchestrator/shared/kernel/single-flight.js";
import {
  applyOrchestratorDispatchTerminalState,
  buildOrchestratorDispatchPayload,
  isOrchestratorDispatchClosed,
  loadOrchestratorDispatchTerminalState,
  resolveOrchestratorErrorMessage,
  resolveOrchestratorDispatchTerminalState,
  wasOrchestratorDispatchTimedOut,
  withOrchestratorDispatchGate
} from "../services/orchestrator/shared/dispatch-lifecycle.js";

test("dispatch lifecycle payload keeps shared fields stable and supports optional message id", () => {
  const payload = buildOrchestratorDispatchPayload(
    {
      requestId: "req-1",
      dispatchId: "dispatch-1",
      dispatchKind: "task",
      messageId: "msg-1"
    },
    {
      mode: "manual",
      runId: "run-1"
    }
  );

  assert.deepEqual(payload, {
    requestId: "req-1",
    dispatchId: "dispatch-1",
    dispatchKind: "task",
    messageId: "msg-1",
    mode: "manual",
    runId: "run-1"
  });
});

test("dispatch lifecycle helpers detect closed and timed-out dispatches from event stream", () => {
  const events = [
    {
      eventType: "ORCHESTRATOR_DISPATCH_STARTED",
      createdAt: "2026-03-28T00:00:00.000Z",
      sessionId: "session-1",
      payload: {
        dispatchId: "dispatch-1"
      }
    },
    {
      eventType: "SESSION_HEARTBEAT_TIMEOUT",
      createdAt: "2026-03-28T00:01:00.000Z",
      sessionId: "session-1",
      payload: {
        dispatchId: "dispatch-1"
      }
    },
    {
      eventType: "ORCHESTRATOR_DISPATCH_FAILED",
      createdAt: "2026-03-28T00:02:00.000Z",
      sessionId: "session-1",
      payload: {
        dispatchId: "dispatch-1"
      }
    }
  ];

  assert.equal(wasOrchestratorDispatchTimedOut(events, "session-1", "dispatch-1"), true);
  assert.equal(isOrchestratorDispatchClosed(events, "dispatch-1"), true);
  assert.deepEqual(resolveOrchestratorDispatchTerminalState(events, "session-1", "dispatch-1"), {
    closed: true,
    timedOut: true
  });
  assert.equal(wasOrchestratorDispatchTimedOut(events, "session-2", "dispatch-1"), false);
  assert.equal(isOrchestratorDispatchClosed(events, "dispatch-2"), false);
});

test("dispatch lifecycle loader resolves terminal state from repository callback", async () => {
  const terminalState = await loadOrchestratorDispatchTerminalState(
    async () => [
      {
        eventType: "RUNNER_TIMEOUT_SOFT",
        createdAt: "2026-03-28T00:01:00.000Z",
        sessionId: "session-1",
        payload: {
          dispatchId: "dispatch-1"
        }
      },
      {
        eventType: "ORCHESTRATOR_DISPATCH_FINISHED",
        createdAt: "2026-03-28T00:02:00.000Z",
        sessionId: "session-1",
        payload: {
          dispatchId: "dispatch-1"
        }
      }
    ],
    "session-1",
    "dispatch-1"
  );

  assert.deepEqual(terminalState, {
    closed: true,
    timedOut: true
  });
});

test("dispatch lifecycle state applier skips closed dispatch and applies for open dispatch", async () => {
  let operationCalls = 0;
  const closedState = await applyOrchestratorDispatchTerminalState(
    async () => [
      {
        eventType: "ORCHESTRATOR_DISPATCH_FINISHED",
        createdAt: "2026-03-28T00:02:00.000Z",
        sessionId: "session-1",
        payload: {
          dispatchId: "dispatch-1"
        }
      }
    ],
    "session-1",
    "dispatch-1",
    async () => {
      operationCalls += 1;
    }
  );
  assert.deepEqual(closedState, { closed: true, timedOut: false });
  assert.equal(operationCalls, 0);

  const openState = await applyOrchestratorDispatchTerminalState(
    async () => [
      {
        eventType: "ORCHESTRATOR_DISPATCH_STARTED",
        createdAt: "2026-03-28T00:00:00.000Z",
        sessionId: "session-1",
        payload: {
          dispatchId: "dispatch-2"
        }
      }
    ],
    "session-1",
    "dispatch-2",
    async () => {
      operationCalls += 1;
    }
  );
  assert.deepEqual(openState, { closed: false, timedOut: false });
  assert.equal(operationCalls, 1);
});

test("dispatch gate returns busy result and always releases the key", async () => {
  const gate = new OrchestratorSingleFlightGate();

  const ok = await withOrchestratorDispatchGate(
    gate,
    "scope::session",
    () => "busy",
    async () => {
      assert.equal(gate.has("scope::session"), true);
      return "ok";
    }
  );
  assert.equal(ok, "ok");
  assert.equal(gate.has("scope::session"), false);

  gate.add("scope::session");
  const busy = await withOrchestratorDispatchGate(
    gate,
    "scope::session",
    () => "busy",
    async () => "should-not-run"
  );
  assert.equal(busy, "busy");
  gate.delete("scope::session");

  await assert.rejects(
    () =>
      withOrchestratorDispatchGate(
        gate,
        "scope::session",
        () => "busy",
        async () => {
          throw new Error("boom");
        }
      ),
    /boom/
  );
  assert.equal(gate.has("scope::session"), false);
});

test("dispatch lifecycle resolves stable error message from unknown inputs", () => {
  assert.equal(resolveOrchestratorErrorMessage(new Error("boom")), "boom");
  assert.equal(resolveOrchestratorErrorMessage("  plain-text  "), "plain-text");
  assert.equal(resolveOrchestratorErrorMessage({ code: "E_TEST" }), "Unknown error");
  assert.equal(resolveOrchestratorErrorMessage(null), "Unknown error");
  assert.equal(resolveOrchestratorErrorMessage(undefined, "fallback"), "fallback");
});
