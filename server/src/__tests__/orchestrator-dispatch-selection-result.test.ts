import assert from "node:assert/strict";
import test from "node:test";
import { buildNormalizedDispatchSelectionResult } from "../services/orchestrator/shared/index.js";

test("buildNormalizedDispatchSelectionResult keeps normalized fields and infers message_id", () => {
  const session = { sessionId: "session-dev", role: "dev" };
  const message = {
    envelope: {
      message_id: "msg-1"
    },
    body: {
      messageType: "MANAGER_MESSAGE"
    }
  };

  const result = buildNormalizedDispatchSelectionResult({
    role: "dev",
    session,
    dispatchKind: "message",
    taskId: "task-a",
    message,
    requestId: "request-1"
  });

  assert.deepEqual(result, {
    role: "dev",
    session,
    dispatchKind: "message",
    taskId: "task-a",
    message,
    messageId: "msg-1",
    requestId: "request-1",
    skipReason: undefined,
    terminalOutcome: undefined
  });
});

test("buildNormalizedDispatchSelectionResult returns null messageId when envelope message_id is absent", () => {
  const session = { sessionId: "session-dev", role: "dev" };
  const message = {
    envelope: {},
    body: {}
  };

  const result = buildNormalizedDispatchSelectionResult({
    role: "dev",
    session,
    dispatchKind: "task",
    taskId: "task-a",
    message,
    requestId: null
  });

  assert.equal(result.messageId, null);
  assert.equal(result.requestId, null);
});
