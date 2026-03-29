import assert from "node:assert/strict";
import test from "node:test";
import { executeOrchestratorLaunch } from "../services/orchestrator/shared/launch-template.js";

test("launch template executes started then success handlers", async () => {
  const order: string[] = [];

  const result = await executeOrchestratorLaunch(
    { id: "launch-1" },
    {
      createContext: async (input: { id: string }) => {
        order.push(`create:${input.id}`);
        return { id: input.id };
      },
      appendStarted: async (context: { id: string }) => {
        order.push(`started:${context.id}`);
      },
      execute: async (context: { id: string }) => {
        order.push(`execute:${context.id}`);
        return { finished: context.id };
      },
      onSuccess: async (_context: { id: string }, executionResult: { finished: string }) => {
        order.push(`success:${executionResult.finished}`);
        return executionResult.finished;
      },
      onFailure: async () => {
        throw new Error("should not fail");
      }
    }
  );

  assert.equal(result, "launch-1");
  assert.deepEqual(order, ["create:launch-1", "started:launch-1", "execute:launch-1", "success:launch-1"]);
});

test("launch template routes execution failure through failure handler", async () => {
  const order: string[] = [];

  const result = await executeOrchestratorLaunch(
    { id: "launch-2" },
    {
      createContext: async (input: { id: string }) => ({ id: input.id }),
      appendStarted: async (context: { id: string }) => {
        order.push(`started:${context.id}`);
      },
      execute: async () => {
        throw new Error("boom");
      },
      onSuccess: async () => {
        throw new Error("should not succeed");
      },
      onFailure: async (_context: { id: string }, error: unknown) => {
        order.push(`failed:${error instanceof Error ? error.message : String(error)}`);
        return "failed";
      }
    }
  );

  assert.equal(result, "failed");
  assert.deepEqual(order, ["started:launch-2", "failed:boom"]);
});
