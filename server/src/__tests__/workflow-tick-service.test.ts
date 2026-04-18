import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowTickService } from "../services/orchestrator/workflow/workflow-tick-service.js";

test("workflow tick service executes timeout -> finalize -> reminder -> dispatch order", async () => {
  const order: string[] = [];
  const run = {
    runId: "run-order",
    status: "running",
    autoDispatchEnabled: true,
    autoDispatchRemaining: 1,
    holdEnabled: false
  } as any;

  const service = new WorkflowTickService({
    repositories: {
      workflowRuns: {
        listRuns: async () => [run]
      },
      sessions: {
        listSessions: async () => []
      },
      events: {
        appendEvent: async () => ({})
      }
    } as any,
    kernel: {
      runTick: async ({ listContexts, tickContext }: any) => {
        const contexts = await listContexts();
        for (const context of contexts) {
          await tickContext(context);
        }
      }
    } as any,
    activeRunIds: new Set<string>(),
    runHoldState: new Map<string, boolean>(),
    pruneInactiveRunScopedState: () => {},
    ensureRuntime: async () => ({
      initializedAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z",
      transitionSeq: 0,
      tasks: []
    }),
    sessionRuntimeService: {
      markTimedOutSessions: async () => {
        order.push("timeout");
      }
    } as any,
    reminderService: {
      checkRoleReminders: async () => {
        order.push("reminder");
      }
    } as any,
    completionService: {
      checkAndFinalizeRunByStableWindow: async () => {
        order.push("finalize");
        return false;
      }
    } as any,
    dispatchService: {
      dispatchRun: async () => {
        order.push("dispatch");
        return {
          runId: run.runId,
          dispatchedCount: 1,
          remainingBudget: 0,
          results: [{ outcome: "dispatched", dispatchKind: "task" }]
        };
      }
    } as any
  });

  await service.tickLoop();

  assert.deepEqual(order, ["timeout", "finalize", "reminder", "dispatch"]);
});
