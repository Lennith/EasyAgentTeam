import assert from "node:assert/strict";
import test from "node:test";
import { executeOrchestratorRunner } from "../services/orchestrator/shared/runner-template.js";

test("runner handles appendStarted failure through failure lifecycle", async () => {
  const calls: string[] = [];

  const result = await executeOrchestratorRunner(
    { id: "input-1" },
    {
      createContext: async (input) => ({ input, dispatchId: "dispatch-1" }),
      execute: async () => {
        calls.push("execute");
        return "ok";
      },
      onSuccess: async () => "success",
      onFailure: async (_context, error) => {
        calls.push(`onFailure:${(error as Error).message}`);
        return "failed";
      }
    },
    {
      appendStarted: async () => {
        calls.push("appendStarted");
        throw new Error("started write failed");
      },
      appendFailure: async (_context, error) => {
        calls.push(`appendFailure:${(error as Error).message}`);
      }
    }
  );

  assert.equal(result, "failed");
  assert.deepEqual(calls, ["appendStarted", "appendFailure:started write failed", "onFailure:started write failed"]);
});
