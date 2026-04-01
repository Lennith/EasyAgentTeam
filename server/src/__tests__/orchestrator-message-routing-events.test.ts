import assert from "node:assert/strict";
import test from "node:test";
import {
  appendOrchestratorMessageRouteEventPair,
  buildOrchestratorMessageRouteResult
} from "../services/orchestrator/shared/index.js";

test("message route event pair appends received then routed", async () => {
  const appended: string[] = [];
  await appendOrchestratorMessageRouteEventPair(
    async (event: { id: string }) => {
      appended.push(event.id);
    },
    {
      received: { id: "received" },
      routed: { id: "routed" }
    }
  );

  assert.deepEqual(appended, ["received", "routed"]);
});

test("message route result helper keeps normalized null fields and preserves extras", () => {
  const result = buildOrchestratorMessageRouteResult({
    requestId: "req-1",
    messageId: "msg-1",
    messageType: "MANAGER_MESSAGE",
    resolvedSessionId: "session-1",
    createdAt: "2026-03-30T00:00:00.000Z",
    taskId: undefined,
    toRole: null,
    mode: "CHAT" as const
  });

  assert.deepEqual(result, {
    requestId: "req-1",
    messageId: "msg-1",
    messageType: "MANAGER_MESSAGE",
    taskId: null,
    toRole: null,
    resolvedSessionId: "session-1",
    createdAt: "2026-03-30T00:00:00.000Z",
    mode: "CHAT"
  });
});
