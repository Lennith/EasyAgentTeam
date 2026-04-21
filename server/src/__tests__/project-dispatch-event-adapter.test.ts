import assert from "node:assert/strict";
import test from "node:test";
import { ProjectDispatchEventAdapter } from "../services/orchestrator/project/project-dispatch-event-adapter.js";

test("project dispatch event adapter preserves recovery attempt metadata when provided", async () => {
  const appended: Array<{ paths: unknown; event: unknown }> = [];
  const adapter = new ProjectDispatchEventAdapter({
    events: {
      appendEvent: async (paths: unknown, event: unknown) => {
        appended.push({ paths, event });
      }
    }
  } as any);

  const project = { projectId: "project-1" } as any;
  const paths = { projectRootDir: "C:\\memory\\project-1" } as any;

  await adapter.appendStarted(
    {
      project,
      paths,
      sessionId: "session-1",
      taskId: "task-1"
    },
    {
      dispatchId: "dispatch-1",
      requestId: "req-1",
      dispatchKind: "task",
      mode: "manual",
      messageIds: ["msg-1"],
      recovery_attempt_id: "attempt-1"
    }
  );

  await adapter.appendFinished(
    {
      project,
      paths,
      sessionId: "session-1",
      taskId: "task-1"
    },
    {
      dispatchId: "dispatch-1",
      requestId: "req-1",
      dispatchKind: "task",
      mode: "manual",
      messageIds: ["msg-1"],
      recovery_attempt_id: "attempt-1",
      runId: "run-1",
      exitCode: 0,
      timedOut: false,
      startedAt: "2026-04-21T10:00:00.000Z",
      finishedAt: "2026-04-21T10:00:05.000Z"
    }
  );

  await adapter.appendFailed(
    {
      project,
      paths,
      sessionId: "session-1",
      taskId: "task-1"
    },
    {
      dispatchId: "dispatch-1",
      requestId: "req-1",
      dispatchKind: "task",
      mode: "manual",
      messageIds: ["msg-1"],
      error: "boom"
    }
  );

  assert.deepEqual(appended, [
    {
      paths,
      event: {
        projectId: "project-1",
        eventType: "ORCHESTRATOR_DISPATCH_STARTED",
        source: "manager",
        sessionId: "session-1",
        taskId: "task-1",
        payload: {
          requestId: "req-1",
          dispatchId: "dispatch-1",
          dispatchKind: "task",
          mode: "manual",
          messageIds: ["msg-1"],
          recovery_attempt_id: "attempt-1"
        }
      }
    },
    {
      paths,
      event: {
        projectId: "project-1",
        eventType: "ORCHESTRATOR_DISPATCH_FINISHED",
        source: "manager",
        sessionId: "session-1",
        taskId: "task-1",
        payload: {
          requestId: "req-1",
          dispatchId: "dispatch-1",
          dispatchKind: "task",
          mode: "manual",
          messageIds: ["msg-1"],
          recovery_attempt_id: "attempt-1",
          runId: "run-1",
          exitCode: 0,
          timedOut: false,
          startedAt: "2026-04-21T10:00:00.000Z",
          finishedAt: "2026-04-21T10:00:05.000Z"
        }
      }
    },
    {
      paths,
      event: {
        projectId: "project-1",
        eventType: "ORCHESTRATOR_DISPATCH_FAILED",
        source: "manager",
        sessionId: "session-1",
        taskId: "task-1",
        payload: {
          requestId: "req-1",
          dispatchId: "dispatch-1",
          dispatchKind: "task",
          mode: "manual",
          messageIds: ["msg-1"],
          error: "boom"
        }
      }
    }
  ]);
});
