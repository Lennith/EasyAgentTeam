import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdapterBackedOrchestratorTickPipeline,
  createOrchestratorTickPipeline,
  runAdapterBackedOrchestratorTickLoop,
  syncOrchestratorHoldState
} from "../services/orchestrator/shared/tick-pipeline.js";

test("shared tick pipeline preserves configured order and stops on directive", async () => {
  const order: string[] = [];
  const pipeline = createOrchestratorTickPipeline<{ scopeId: string }>([
    {
      name: "timeout",
      run: async () => {
        order.push("timeout");
      }
    },
    {
      name: "finalize",
      run: async () => {
        order.push("finalize");
        return "stop";
      }
    },
    {
      name: "reminder",
      run: async () => {
        order.push("reminder");
      }
    }
  ]);

  await pipeline.run({ scopeId: "scope-1" });

  assert.deepEqual(pipeline.phaseOrder, ["timeout", "finalize", "reminder"]);
  assert.deepEqual(order, ["timeout", "finalize"]);
});

test("adapter-backed tick pipeline skips hold-gated phases but still emits observability", async () => {
  const order: string[] = [];
  const pipeline = createAdapterBackedOrchestratorTickPipeline<{ holdEnabled: boolean }>({
    phaseOrder: ["timeout", "reminder", "completion", "observability", "autoDispatchBudget"],
    scopeIsOnHold: (scope) => scope.holdEnabled,
    sessionRuntime: {
      markTimedOut: async () => {
        order.push("timeout");
      }
    },
    reminder: {
      checkReminders: async () => {
        order.push("reminder");
      }
    },
    completion: {
      runCompletion: async () => {
        order.push("completion");
      },
      emitObservabilitySnapshot: async () => {
        order.push("observability");
      }
    },
    updateAutoDispatchBudget: async () => {
      order.push("budget");
    }
  });

  await pipeline.run({ holdEnabled: true });

  assert.deepEqual(pipeline.phaseOrder, ["timeout", "reminder", "completion", "observability", "autoDispatchBudget"]);
  assert.deepEqual(order, ["timeout", "observability"]);
});

test("adapter-backed tick pipeline stops when finalize adapter requests termination", async () => {
  const order: string[] = [];
  const pipeline = createAdapterBackedOrchestratorTickPipeline<{ scopeId: string }>({
    phaseOrder: ["timeout", "finalize", "reminder", "completion"],
    sessionRuntime: {
      markTimedOut: async () => {
        order.push("timeout");
      }
    },
    reminder: {
      checkReminders: async () => {
        order.push("reminder");
      }
    },
    completion: {
      finalize: async () => {
        order.push("finalize");
        return true;
      },
      runCompletion: async () => {
        order.push("completion");
      }
    }
  });

  await pipeline.run({ scopeId: "scope-2" });

  assert.deepEqual(pipeline.phaseOrder, ["timeout", "finalize", "reminder", "completion"]);
  assert.deepEqual(order, ["timeout", "finalize"]);
});

test("adapter-backed tick loop resolves scopes and skips null contexts", async () => {
  const visited: string[] = [];
  await runAdapterBackedOrchestratorTickLoop({
    kernel: {
      runTick: async ({ listContexts, tickContext }: any) => {
        const contexts = await listContexts();
        for (const context of contexts) {
          await tickContext(context);
        }
      }
    } as any,
    listContexts: async () => [{ scopeId: "a" }, { scopeId: "skip" }, { scopeId: "b" }],
    resolveScope: async (context) => (context.scopeId === "skip" ? null : context),
    beforeScope: async (scope) => {
      visited.push(`before:${scope.scopeId}`);
    },
    tickPipeline: {
      phaseOrder: [],
      run: async (scope) => {
        visited.push(`run:${scope.scopeId}`);
      }
    }
  });

  assert.deepEqual(visited, ["before:a", "run:a", "before:b", "run:b"]);
});

test("hold-state sync emits only when value changes", async () => {
  const emitted: boolean[] = [];
  const previousState = new Map<string, boolean>();

  assert.equal(
    await syncOrchestratorHoldState({
      scopeId: "scope-1",
      holdEnabled: true,
      previousState,
      appendEvent: async (holdEnabled) => {
        emitted.push(holdEnabled);
      }
    }),
    true
  );
  assert.equal(
    await syncOrchestratorHoldState({
      scopeId: "scope-1",
      holdEnabled: true,
      previousState,
      appendEvent: async (holdEnabled) => {
        emitted.push(holdEnabled);
      }
    }),
    false
  );
  assert.equal(
    await syncOrchestratorHoldState({
      scopeId: "scope-1",
      holdEnabled: false,
      previousState,
      appendEvent: async (holdEnabled) => {
        emitted.push(holdEnabled);
      }
    }),
    true
  );

  assert.deepEqual(emitted, [true, false]);
});
