import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowCompletionService } from "../services/orchestrator/workflow/workflow-completion-service.js";

test("workflow completion service marks tasks as MAY_BE_DONE when dispatch threshold and valid output are met", async () => {
  const now = new Date().toISOString();
  const run = {
    runId: "run-may-be-done",
    workspacePath: "C:\\memory\\run-may-be-done",
    tasks: [{ taskId: "task-a", ownerRole: "dev" }]
  } as any;
  const runtime = {
    initializedAt: now,
    updatedAt: now,
    transitionSeq: 1,
    tasks: [
      {
        taskId: "task-a",
        state: "READY",
        lastSummary: "Substantial output summary already exists.",
        blockedBy: [],
        blockedReasons: [],
        lastTransitionAt: now,
        transitionCount: 1,
        transitions: [{ seq: 1, at: now, fromState: null, toState: "READY" }]
      }
    ]
  } as any;
  const refreshedRuntime = {
    initializedAt: now,
    updatedAt: now,
    transitionSeq: 1,
    tasks: [
      {
        taskId: "task-a",
        state: "READY",
        lastSummary: "Substantial output summary already exists.",
        blockedBy: [],
        blockedReasons: [],
        lastTransitionAt: now,
        transitionCount: 1,
        transitions: [{ seq: 1, at: now, fromState: null, toState: "READY" }]
      }
    ]
  } as any;
  const appendedEvents: any[] = [];
  const writes: any[] = [];
  const patches: any[] = [];

  const service = new WorkflowCompletionService({
    repositories: {
      workflowRuns: {
        writeRuntime: async (_runId: string, nextRuntime: unknown) => {
          writes.push(nextRuntime);
        },
        patchRun: async (_runId: string, patch: unknown) => {
          patches.push(patch);
          return { ...run, ...(patch as Record<string, unknown>) };
        }
      },
      events: {
        listEvents: async () =>
          Array.from({ length: 5 }, (_, index) => ({
            eventType: "ORCHESTRATOR_DISPATCH_STARTED",
            createdAt: now,
            taskId: "task-a",
            payload: { dispatchKind: "task", dispatchId: `dispatch-${index}` }
          })),
        appendEvent: async (_runId: string, event: unknown) => {
          appendedEvents.push(event);
          return event;
        }
      }
    } as any,
    runAutoFinishStableTicks: new Map<string, number>(),
    onRunFinished: () => {},
    loadRunOrThrow: async () => run,
    readConvergedRuntime: async () => refreshedRuntime,
    runWorkflowTransaction: async (_runId, operation) => operation()
  });

  await service.checkAndMarkMayBeDone(run, runtime);

  assert.equal(writes.length, 1);
  assert.equal(patches.length, 1);
  assert.equal(refreshedRuntime.tasks[0].state, "MAY_BE_DONE");
  assert.equal(
    appendedEvents.some((event) => (event as any).eventType === "TASK_MAY_BE_DONE_MARKED"),
    true
  );
});

test("workflow completion service auto-finishes after the stable window is satisfied", async () => {
  const run = { runId: "run-finish" } as any;
  const runtime = {
    initializedAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:00:00.000Z",
    transitionSeq: 1,
    tasks: [
      {
        taskId: "task-a",
        state: "DONE",
        blockedBy: [],
        blockedReasons: [],
        lastTransitionAt: "2026-03-28T00:00:00.000Z",
        transitionCount: 1,
        transitions: [{ seq: 1, at: "2026-03-28T00:00:00.000Z", fromState: null, toState: "DONE" }]
      }
    ]
  } as any;
  const sessions = [{ sessionId: "session-dev", status: "idle" }] as any;
  const runAutoFinishStableTicks = new Map<string, number>([["run-finish", 1]]);
  const appendedEvents: any[] = [];
  const runtimeWrites: any[] = [];
  const patchedRuns: any[] = [];
  const finishedRunIds: string[] = [];

  const service = new WorkflowCompletionService({
    repositories: {
      workflowRuns: {
        writeRuntime: async (_runId: string, nextRuntime: unknown) => {
          runtimeWrites.push(nextRuntime);
        },
        patchRun: async (_runId: string, patch: unknown) => {
          patchedRuns.push(patch);
          return { ...run, ...(patch as Record<string, unknown>) };
        }
      },
      events: {
        appendEvent: async (_runId: string, event: unknown) => {
          appendedEvents.push(event);
          return event;
        }
      }
    } as any,
    runAutoFinishStableTicks,
    onRunFinished: (runId) => {
      finishedRunIds.push(runId);
    },
    loadRunOrThrow: async () => run,
    readConvergedRuntime: async () => runtime,
    runWorkflowTransaction: async (_runId, operation) => operation()
  });

  const finalized = await service.checkAndFinalizeRunByStableWindow(run, runtime, sessions);

  assert.equal(finalized, true);
  assert.equal(runtimeWrites.length, 1);
  assert.equal(typeof (runtimeWrites[0] as { updatedAt: string }).updatedAt, "string");
  assert.equal(patchedRuns.length, 1);
  assert.deepEqual(finishedRunIds, ["run-finish"]);
  assert.equal(
    appendedEvents.some((event) => (event as any).eventType === "ORCHESTRATOR_RUN_AUTO_FINISHED"),
    true
  );
});
