import assert from "node:assert/strict";
import test from "node:test";
import { ProjectTickService } from "../services/orchestrator/project/project-tick-service.js";

test("project tick service executes timeout -> reminder -> may-be-done -> observability -> budget update order", async () => {
  const order: string[] = [];
  const project = {
    projectId: "project-order",
    autoDispatchEnabled: true,
    autoDispatchRemaining: 1,
    holdEnabled: false,
    reminderMode: "backoff"
  } as any;
  const paths = { projectRootDir: "C:\\memory\\project-order" } as any;

  const service = new ProjectTickService({
    dataRoot: "C:\\memory",
    repositories: {
      resolveScope: async () => ({ project, paths }),
      projectRuntime: {
        listProjects: async () => [{ projectId: project.projectId }],
        getProject: async () => project,
        ensureProjectRuntime: async () => paths,
        updateProjectOrchestratorSettings: async () => project
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
    projectHoldState: new Map<string, boolean>(),
    limitEventSent: new Set<string>(),
    sessionRuntimeService: {
      markTimedOutSessions: async () => {
        order.push("timeout");
      }
    } as any,
    reminderService: {
      checkIdleRoles: async () => {
        order.push("reminder");
      }
    } as any,
    completionService: {
      checkAndMarkMayBeDone: async () => {
        order.push("may-be-done");
      },
      emitDispatchObservabilitySnapshot: async () => {
        order.push("observability");
      }
    } as any,
    dispatchService: {
      dispatchProject: async () => {
        order.push("dispatch");
        return {
          projectId: project.projectId,
          mode: "loop",
          results: [{ outcome: "dispatched", dispatchKind: "task" }]
        };
      }
    } as any
  });

  await service.tickLoop();
  assert.deepEqual(order, ["timeout", "reminder", "may-be-done", "observability", "dispatch"]);
});
