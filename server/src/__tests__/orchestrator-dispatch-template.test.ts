import assert from "node:assert/strict";
import test from "node:test";
import { OrchestratorSingleFlightGate } from "../services/orchestrator/kernel/single-flight.js";
import { runOrchestratorDispatchTemplate } from "../services/orchestrator/shared/dispatch-template.js";

type DispatchRow = {
  outcome: "run_not_running" | "session_busy" | "dispatched" | "no_task" | "already_dispatched";
  key?: string;
};

test("dispatch template short-circuits on before-loop preflight", async () => {
  const gate = new OrchestratorSingleFlightGate();
  let selectCalled = false;

  const result = await runOrchestratorDispatchTemplate<{ mode: string }, { key: string }, void, DispatchRow>({
    state: { mode: "manual" },
    gate,
    maxDispatches: 1,
    preflight: {
      beforeLoop: async () => ({ outcome: "run_not_running" })
    },
    mutation: {
      prepareDispatch: async () => undefined
    },
    execution: {
      selectNext: async () => {
        selectCalled = true;
        return { status: "none" as const, busyFound: false };
      },
      getSingleFlightKey: () => "unused",
      createSingleFlightBusyResult: () => ({ outcome: "session_busy" }),
      dispatch: async () => ({ outcome: "dispatched" }),
      buildNoSelectionResult: () => ({ outcome: "no_task" })
    }
  });

  assert.equal(selectCalled, false);
  assert.deepEqual(result, {
    results: [{ outcome: "run_not_running" }],
    dispatchedCount: 0
  });
});

test("dispatch template routes selection through gate and counts only dispatched results", async () => {
  const gate = new OrchestratorSingleFlightGate();
  const prepared: string[] = [];
  const afterDispatch: string[] = [];
  let calls = 0;

  const result = await runOrchestratorDispatchTemplate<
    Record<string, never>,
    { key: string },
    { key: string },
    DispatchRow
  >({
    state: {},
    gate,
    maxDispatches: 3,
    preflight: {
      beforeLoop: async () => null
    },
    mutation: {
      prepareDispatch: async (selection: { key: string }) => {
        prepared.push(selection.key);
        return { key: selection.key };
      }
    },
    execution: {
      selectNext: async () => {
        calls += 1;
        if (calls === 1) {
          return { status: "selected" as const, selection: { key: "session-1" } };
        }
        if (calls === 2) {
          return {
            status: "skipped" as const,
            result: { outcome: "already_dispatched", key: "session-2" }
          };
        }
        return { status: "none" as const, busyFound: false };
      },
      getSingleFlightKey: (selection) => selection.key,
      createSingleFlightBusyResult: (selection) => ({
        outcome: "session_busy",
        key: selection.key
      }),
      dispatch: async (_selection, dispatchInput) => ({
        outcome: "dispatched",
        key: dispatchInput.key
      }),
      buildNoSelectionResult: () => ({ outcome: "no_task", key: "none" }),
      shouldCountAsDispatch: (dispatchRow) => dispatchRow.outcome === "dispatched",
      shouldContinue: (dispatchRow) => dispatchRow.outcome === "dispatched"
    },
    finalize: {
      afterDispatch: async (dispatchRow) => {
        afterDispatch.push(dispatchRow.outcome);
      }
    }
  });

  assert.deepEqual(prepared, ["session-1"]);
  assert.deepEqual(afterDispatch, ["dispatched", "already_dispatched"]);
  assert.equal(gate.has("session-1"), false);
  assert.deepEqual(result, {
    results: [
      { outcome: "dispatched", key: "session-1" },
      { outcome: "already_dispatched", key: "session-2" }
    ],
    dispatchedCount: 1
  });
});

test("dispatch template emits synthesized no-selection result when nothing is chosen", async () => {
  const gate = new OrchestratorSingleFlightGate();

  const result = await runOrchestratorDispatchTemplate<{ busy: boolean }, { key: string }, void, DispatchRow>({
    state: { busy: true },
    gate,
    maxDispatches: 1,
    preflight: {
      beforeLoop: async () => null
    },
    mutation: {
      prepareDispatch: async () => undefined
    },
    execution: {
      selectNext: async () => ({ status: "none" as const, busyFound: true }),
      getSingleFlightKey: () => "unused",
      createSingleFlightBusyResult: () => ({ outcome: "session_busy" }),
      dispatch: async () => ({ outcome: "dispatched" }),
      buildNoSelectionResult: (_state, busyFound) => ({
        outcome: busyFound ? "session_busy" : "no_task"
      })
    }
  });

  assert.deepEqual(result, {
    results: [{ outcome: "session_busy" }],
    dispatchedCount: 0
  });
});
