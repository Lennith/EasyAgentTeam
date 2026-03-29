import assert from "node:assert/strict";
import test from "node:test";
import { OrchestratorSingleFlightGate } from "../services/orchestrator/kernel/single-flight.js";
import {
  buildOrchestratorDispatchPayload,
  isOrchestratorDispatchClosed,
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
  assert.equal(wasOrchestratorDispatchTimedOut(events, "session-2", "dispatch-1"), false);
  assert.equal(isOrchestratorDispatchClosed(events, "dispatch-2"), false);
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
