import assert from "node:assert/strict";
import test from "node:test";
import { runOrchestratorTaskActionPipeline } from "../services/orchestrator/shared/task-action-template.js";

test("task action pipeline executes parse -> auth -> gate -> apply -> converge -> emit", async () => {
  const order: string[] = [];
  const result = await runOrchestratorTaskActionPipeline(
    { raw: "TASK_REPORT" },
    {
      parse: async (input: { raw: string }) => {
        order.push("parse");
        return { actionType: input.raw };
      },
      authorize: async (parsed: { actionType: string }) => {
        order.push("auth");
        return parsed;
      },
      checkDependencyGate: async (authorized: { actionType: string }) => {
        order.push("gate");
        return authorized;
      },
      apply: async (gated: { actionType: string }) => {
        order.push("apply");
        return { ...gated, applied: true };
      },
      convergeRuntime: async (applied: { actionType: string; applied: boolean }) => {
        order.push("converge");
        return { ...applied, converged: true };
      },
      emit: async (converged: { actionType: string; applied: boolean; converged: boolean }) => {
        order.push("emit");
        return converged;
      }
    }
  );

  assert.deepEqual(order, ["parse", "auth", "gate", "apply", "converge", "emit"]);
  assert.deepEqual(result, {
    actionType: "TASK_REPORT",
    applied: true,
    converged: true
  });
});

test("task action pipeline stops when dependency gate rejects", async () => {
  await assert.rejects(
    async () =>
      await runOrchestratorTaskActionPipeline(
        { raw: "TASK_REPORT" },
        {
          parse: async () => ({ actionType: "TASK_REPORT" }),
          authorize: async (parsed: { actionType: string }) => parsed,
          checkDependencyGate: async () => {
            throw new Error("dependency not ready");
          },
          apply: async () => ({ applied: true }),
          convergeRuntime: async (applied: { applied: boolean }) => applied,
          emit: async (converged: { applied: boolean }) => converged
        }
      ),
    /dependency not ready/
  );
});
