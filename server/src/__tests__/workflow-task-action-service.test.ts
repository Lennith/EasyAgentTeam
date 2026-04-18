import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowTaskActionService } from "../services/orchestrator/workflow/workflow-task-action-service.js";

function buildSnapshot(tasks: Array<Record<string, unknown>>) {
  return {
    runId: "run-1",
    status: "running",
    active: true,
    updatedAt: "2026-03-28T12:00:00.000Z",
    counters: {
      total: tasks.length,
      planned: 0,
      ready: 0,
      dispatched: 0,
      inProgress: 0,
      blocked: 0,
      done: 0,
      canceled: 0
    },
    tasks
  } as any;
}

test("workflow task action service delegates discuss actions through message routing", async () => {
  const appendedEvents: Array<Record<string, unknown>> = [];
  const routedMessages: Array<Record<string, unknown>> = [];

  const service = new WorkflowTaskActionService({
    repositories: {
      events: {
        appendEvent: async (_runId: string, event: Record<string, unknown>) => {
          appendedEvents.push(event);
        }
      }
    } as any,
    loadRunOrThrow: async () => ({ runId: "run-1", status: "running" }) as any,
    ensureRuntime: async () => ({ updatedAt: "2026-03-28T12:00:00.000Z", tasks: [] }) as any,
    readConvergedRuntime: async () => ({ updatedAt: "2026-03-28T12:00:00.000Z", tasks: [] }) as any,
    runWorkflowTransaction: async <T>(_runId: string, operation: () => Promise<T>) => await operation(),
    sendRunMessage: async (input) => {
      routedMessages.push(input as any);
      return {
        requestId: "req-1",
        messageId: "msg-1",
        messageType: "TASK_DISCUSS_REQUEST",
        taskId: "task-b",
        toRole: "architect",
        resolvedSessionId: "session-architect-01",
        createdAt: "2026-03-28T12:00:01.000Z"
      };
    },
    buildSnapshot: (_run, runtime) => buildSnapshot(runtime.tasks as any),
    createRuntimeError: (message: string) => new Error(message)
  });

  const result = await service.applyTaskActions("run-1", {
    actionType: "TASK_DISCUSS_REQUEST",
    fromAgent: "lead",
    fromSessionId: "session-lead-01",
    toRole: "architect",
    taskId: "task-b",
    content: "please review",
    discuss: {
      threadId: "thread-01",
      requestId: "req-1"
    }
  } as any);

  assert.equal(result.success, true);
  assert.equal(result.messageId, "msg-1");
  assert.deepEqual(routedMessages, [
    {
      runId: "run-1",
      fromAgent: "lead",
      fromSessionId: "session-lead-01",
      messageType: "TASK_DISCUSS_REQUEST",
      toRole: "architect",
      toSessionId: undefined,
      taskId: "task-b",
      content: "please review",
      requestId: "req-1",
      discuss: {
        threadId: "thread-01",
        requestId: "req-1"
      }
    }
  ]);
  assert.deepEqual(appendedEvents, [
    {
      eventType: "TASK_ACTION_RECEIVED",
      source: "agent",
      sessionId: "session-lead-01",
      taskId: "task-b",
      payload: {
        actionType: "TASK_DISCUSS_REQUEST",
        fromAgent: "lead",
        toRole: "architect",
        toSessionId: null,
        requestId: "req-1"
      }
    }
  ]);
});

test("workflow task action service creates task with merged dependencies and updated runtime", async () => {
  const writtenRuntimes: Array<Record<string, unknown>> = [];
  const patchedRuns: Array<Record<string, unknown>> = [];
  const appendedEvents: Array<Record<string, unknown>> = [];

  const baseRun = {
    runId: "run-1",
    status: "running",
    tasks: [
      { taskId: "parent", title: "Parent", ownerRole: "lead", dependencies: ["task-a"] },
      { taskId: "task-a", title: "Task A", ownerRole: "lead" },
      { taskId: "task-b", title: "Task B", ownerRole: "architect" }
    ]
  };

  const service = new WorkflowTaskActionService({
    repositories: {
      events: {
        appendEvent: async (_runId: string, event: Record<string, unknown>) => {
          appendedEvents.push(event);
        }
      },
      sessions: {
        listSessions: async () => [{ sessionId: "session-architect-01", role: "architect", status: "idle" }]
      },
      workflowRuns: {
        writeRuntime: async (_runId: string, runtime: Record<string, unknown>) => {
          writtenRuntimes.push(runtime);
        },
        patchRun: async (_runId: string, patch: Record<string, unknown>) => {
          patchedRuns.push(patch);
          return { ...baseRun, ...patch };
        }
      }
    } as any,
    loadRunOrThrow: async () => baseRun as any,
    ensureRuntime: async () =>
      ({
        updatedAt: "2026-03-28T12:00:00.000Z",
        tasks: baseRun.tasks.map((task) => ({
          taskId: task.taskId,
          state: task.taskId === "task-a" ? "DONE" : "READY",
          blockedBy: [],
          blockedReasons: [],
          transitions: []
        }))
      }) as any,
    readConvergedRuntime: async () =>
      ({
        updatedAt: "2026-03-28T12:00:00.000Z",
        tasks: baseRun.tasks.map((task) => ({
          taskId: task.taskId,
          state: task.taskId === "task-a" ? "DONE" : "READY",
          blockedBy: [],
          blockedReasons: [],
          transitions: []
        }))
      }) as any,
    runWorkflowTransaction: async <T>(_runId: string, operation: () => Promise<T>) => await operation(),
    sendRunMessage: async () => {
      throw new Error("sendRunMessage should not be called");
    },
    buildSnapshot: (_run, runtime) => buildSnapshot(runtime.tasks as any),
    createRuntimeError: (message: string) => new Error(message)
  });

  const result = await service.applyTaskActions("run-1", {
    actionType: "TASK_CREATE",
    fromAgent: "architect",
    fromSessionId: "session-architect-01",
    task: {
      taskId: "task-c",
      title: "Task C",
      ownerRole: "architect",
      parentTaskId: "parent",
      dependencies: ["task-b", "task-a"]
    }
  } as any);

  assert.equal(result.success, true);
  assert.equal(result.createdTaskId, "task-c");
  assert.deepEqual(
    (patchedRuns[0] as any)?.tasks?.find((task: any) => task.taskId === "task-c"),
    {
      taskId: "task-c",
      title: "Task C",
      resolvedTitle: "Task C",
      ownerRole: "architect",
      parentTaskId: "parent",
      dependencies: ["task-a", "task-b"],
      acceptance: [],
      artifacts: [],
      creatorRole: "architect",
      creatorSessionId: "session-architect-01"
    }
  );
  assert.equal(writtenRuntimes.length, 1);
  assert.equal(appendedEvents[0]?.eventType, "TASK_ACTION_RECEIVED");
});

test("workflow task action service reports partial apply without mutating session lifecycle", async () => {
  const touchedSessions: Array<{ sessionId: string; patch: Record<string, unknown> }> = [];
  const appendedEvents: Array<Record<string, unknown>> = [];
  const writtenRuntimes: Array<Record<string, unknown>> = [];

  const baseRun = {
    runId: "run-1",
    status: "running",
    tasks: [{ taskId: "task-a", title: "Task A", ownerRole: "lead", dependencies: [] }]
  };
  const runtime = {
    updatedAt: "2026-03-28T12:00:00.000Z",
    tasks: [
      {
        taskId: "task-a",
        state: "READY",
        blockedBy: [],
        blockedReasons: [],
        transitions: []
      }
    ]
  };

  const service = new WorkflowTaskActionService({
    repositories: {
      events: {
        appendEvent: async (_runId: string, event: Record<string, unknown>) => {
          appendedEvents.push(event);
        }
      },
      sessions: {
        touchSession: async (_runId: string, sessionId: string, patch: Record<string, unknown>) => {
          touchedSessions.push({ sessionId, patch });
        }
      },
      workflowRuns: {
        writeRuntime: async (_runId: string, nextRuntime: Record<string, unknown>) => {
          writtenRuntimes.push(nextRuntime);
        },
        patchRun: async (_runId: string, patch: Record<string, unknown>) => ({ ...baseRun, ...patch })
      }
    } as any,
    loadRunOrThrow: async () => baseRun as any,
    ensureRuntime: async () => runtime as any,
    readConvergedRuntime: async () =>
      ({
        updatedAt: runtime.updatedAt,
        tasks: runtime.tasks.map((task) => ({ ...task, transitions: [...(task.transitions ?? [])] }))
      }) as any,
    runWorkflowTransaction: async <T>(_runId: string, operation: () => Promise<T>) => await operation(),
    sendRunMessage: async () => {
      throw new Error("sendRunMessage should not be called");
    },
    buildSnapshot: (_run, nextRuntime) => buildSnapshot(nextRuntime.tasks as any),
    createRuntimeError: (message: string) => new Error(message)
  });

  const result = await service.applyTaskActions("run-1", {
    actionType: "TASK_REPORT",
    fromAgent: "lead",
    fromSessionId: "session-lead-01",
    results: [
      { taskId: "task-a", outcome: "DONE", summary: "done" },
      { taskId: "task-missing", outcome: "DONE", summary: "missing" }
    ]
  } as any);

  assert.equal(result.partialApplied, true);
  assert.deepEqual(result.appliedTaskIds, ["task-a"]);
  assert.deepEqual(result.rejectedResults, [
    {
      taskId: "task-missing",
      reasonCode: "TASK_NOT_FOUND",
      reason: "task 'task-missing' not found"
    }
  ]);
  assert.deepEqual(touchedSessions, []);
  assert.equal(writtenRuntimes.length, 1);
  assert.equal(appendedEvents[0]?.eventType, "TASK_ACTION_RECEIVED");
  assert.equal(appendedEvents[1]?.eventType, "TASK_REPORT_APPLIED");
});
