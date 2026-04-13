import assert from "node:assert/strict";
import test from "node:test";
import {
  appendProjectDispatchTerminalEventForContext,
  appendProjectTerminalDispatchEvent,
  buildProjectDispatchEventScope,
  buildProjectDispatchStartedDetails,
  buildProjectProviderDispatchInput,
  buildProjectRunnerPayload
} from "../services/orchestrator/project/project-dispatch-launch-lifecycle.js";

test("project dispatch launch support builds provider and runner payloads with stable fields", () => {
  const providerInput = buildProjectProviderDispatchInput({
    sessionId: "session-1",
    prompt: "dispatch prompt",
    dispatchId: "dispatch-1",
    taskId: "task-1",
    activeTask: {
      title: "Implement adapter",
      parentTaskId: "parent-1",
      rootTaskId: "root-1"
    },
    requestId: "req-1",
    parentRequestId: "parent-req-1",
    agentRole: "dev",
    modelCommand: "codex",
    modelParams: { model: "gpt-test" }
  });
  const messageRunnerPayload = buildProjectRunnerPayload(
    {
      dataRoot: "C:\\memory",
      project: { projectId: "project-1" } as any,
      paths: { projectRootDir: "C:\\memory\\project-1" } as any,
      sessionId: "session-1",
      taskId: "task-1",
      dispatchKind: "message",
      dispatchId: "dispatch-1",
      messageId: "msg-1"
    },
    "run-1"
  );
  const taskRunnerPayload = buildProjectRunnerPayload(
    {
      dataRoot: "C:\\memory",
      project: { projectId: "project-1" } as any,
      paths: { projectRootDir: "C:\\memory\\project-1" } as any,
      sessionId: "session-1",
      taskId: "task-1",
      dispatchKind: "task",
      dispatchId: "dispatch-1",
      messageId: "msg-1"
    },
    "run-1"
  );

  assert.deepEqual(providerInput, {
    sessionId: "session-1",
    prompt: "dispatch prompt",
    dispatchId: "dispatch-1",
    taskId: "task-1",
    activeTaskTitle: "Implement adapter",
    activeParentTaskId: "parent-1",
    activeRootTaskId: "root-1",
    activeRequestId: "req-1",
    parentRequestId: "parent-req-1",
    agentRole: "dev",
    modelCommand: "codex",
    modelParams: { model: "gpt-test" }
  });
  assert.equal(messageRunnerPayload.messageId, "msg-1");
  assert.equal(taskRunnerPayload.messageId, undefined);
});

test("project dispatch launch support appends terminal failed event with shared details", async () => {
  const emitted: Array<{ kind: string; scope: unknown; details: unknown }> = [];

  await appendProjectTerminalDispatchEvent(
    {
      appendFinished: async (scope, details) => {
        emitted.push({ kind: "finished", scope, details });
      },
      appendFailed: async (scope, details) => {
        emitted.push({ kind: "failed", scope, details });
      }
    },
    buildProjectDispatchEventScope(
      { projectId: "project-1" } as any,
      { projectRootDir: "C:\\memory\\project-1" } as any,
      "session-1",
      "task-1"
    ),
    buildProjectDispatchStartedDetails({
      dispatchId: "dispatch-1",
      dispatchKind: "task",
      requestId: "req-1",
      mode: "manual",
      messageIds: ["msg-1"]
    }),
    {
      dispatchFailedReason: "runner timeout escalated",
      runId: "run-1",
      exitCode: 124,
      timedOut: true,
      startedAt: "2026-03-28T12:00:00.000Z",
      finishedAt: "2026-03-28T12:05:00.000Z"
    }
  );

  assert.deepEqual(emitted, [
    {
      kind: "failed",
      scope: {
        project: { projectId: "project-1" },
        paths: { projectRootDir: "C:\\memory\\project-1" },
        sessionId: "session-1",
        taskId: "task-1"
      },
      details: {
        dispatchId: "dispatch-1",
        dispatchKind: "task",
        requestId: "req-1",
        mode: "manual",
        messageIds: ["msg-1"],
        runId: "run-1",
        exitCode: 124,
        timedOut: true,
        startedAt: "2026-03-28T12:00:00.000Z",
        finishedAt: "2026-03-28T12:05:00.000Z",
        error: "runner timeout escalated"
      }
    }
  ]);
});

test("project dispatch launch support skips terminal append when dispatch is already closed", async () => {
  const emitted: Array<{ kind: string; scope: unknown; details: unknown }> = [];

  await appendProjectDispatchTerminalEventForContext(
    {
      appendStarted: async () => {},
      appendFinished: async (scope: unknown, details: unknown) => {
        emitted.push({ kind: "finished", scope, details });
      },
      appendFailed: async (scope: unknown, details: unknown) => {
        emitted.push({ kind: "failed", scope, details });
      }
    } as any,
    {
      events: {
        listEvents: async () => [
          {
            eventType: "ORCHESTRATOR_DISPATCH_FINISHED",
            createdAt: "2026-03-28T12:06:00.000Z",
            sessionId: "session-1",
            payload: { dispatchId: "dispatch-1" }
          }
        ]
      }
    } as any,
    {
      dispatchId: "dispatch-1",
      startedAt: "2026-03-28T12:00:00.000Z",
      input: {
        project: { projectId: "project-1" },
        paths: { projectRootDir: "C:\\memory\\project-1" },
        session: { sessionId: "session-1", role: "dev" },
        taskId: "task-1",
        dispatchKind: "task",
        selectedMessageIds: ["msg-1"],
        firstMessage: {
          envelope: {
            message_id: "msg-1",
            correlation: {
              request_id: "req-1",
              parent_request_id: null
            }
          }
        },
        input: {
          mode: "manual"
        }
      }
    } as any,
    "session-1",
    {
      dispatchFailedReason: null,
      runId: "run-1",
      exitCode: 0,
      timedOut: false,
      finishedAt: "2026-03-28T12:05:00.000Z"
    }
  );

  assert.deepEqual(emitted, []);
});
