import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowDispatchEventAdapter } from "../services/orchestrator/workflow-dispatch-event-adapter.js";

test("workflow dispatch event adapter preserves finished and failed event contract", async () => {
  const appended: Array<{ runId: string; event: unknown }> = [];
  const adapter = new WorkflowDispatchEventAdapter({
    events: {
      appendEvent: async (runId: string, event: unknown) => {
        appended.push({ runId, event });
      }
    }
  } as any);

  await adapter.appendFinished(
    {
      runId: "run-1",
      sessionId: "session-1",
      taskId: "task-1"
    },
    {
      requestId: "req-1",
      dispatchId: "dispatch-1",
      dispatchKind: "task",
      messageId: null,
      requestedSkillIds: ["skill-1"],
      finishReason: "stop",
      usage: { outputTokens: 12 },
      maxOutputTokens: 128,
      tokenLimit: 512,
      maxTokensRecoveryAttempt: 1,
      maxTokensSnapshotPath: "C:\\snapshot.json",
      recoveredFromMaxTokens: true
    }
  );

  await adapter.appendFailed(
    {
      runId: "run-1",
      sessionId: "session-1",
      taskId: "task-1"
    },
    {
      requestId: "req-1",
      dispatchId: "dispatch-2",
      dispatchKind: "message",
      messageId: "msg-1",
      requestedSkillIds: ["skill-2"],
      error: "dispatch_failed"
    }
  );

  assert.deepEqual(appended, [
    {
      runId: "run-1",
      event: {
        eventType: "ORCHESTRATOR_DISPATCH_FINISHED",
        source: "system",
        sessionId: "session-1",
        taskId: "task-1",
        payload: {
          requestId: "req-1",
          dispatchId: "dispatch-1",
          dispatchKind: "task",
          messageId: null,
          runId: "run-1",
          requestedSkillIds: ["skill-1"],
          finishReason: "stop",
          usage: { outputTokens: 12 },
          maxOutputTokens: 128,
          tokenLimit: 512,
          maxTokensRecoveryAttempt: 1,
          maxTokensSnapshotPath: "C:\\snapshot.json",
          recoveredFromMaxTokens: true
        }
      }
    },
    {
      runId: "run-1",
      event: {
        eventType: "ORCHESTRATOR_DISPATCH_FAILED",
        source: "system",
        sessionId: "session-1",
        taskId: "task-1",
        payload: {
          requestId: "req-1",
          dispatchId: "dispatch-2",
          dispatchKind: "message",
          messageId: "msg-1",
          runId: "run-1",
          requestedSkillIds: ["skill-2"],
          error: "dispatch_failed"
        }
      }
    }
  ]);
});
