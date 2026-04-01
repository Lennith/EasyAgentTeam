import assert from "node:assert/strict";
import test from "node:test";
import { ProjectDispatchEventAdapter } from "../services/orchestrator/project-dispatch-event-adapter.js";

test("project dispatch event adapter preserves started and failed event contract", async () => {
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
      messageIds: ["msg-1"]
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
          messageIds: ["msg-1"]
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
