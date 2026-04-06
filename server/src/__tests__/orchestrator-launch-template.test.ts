import assert from "node:assert/strict";
import test from "node:test";
import {
  createOrchestratorLaunchAdapter,
  executeOrchestratorLaunch
} from "../services/orchestrator/shared/launch-template.js";

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
      appendSuccess: async (_context: { id: string }, executionResult: { finished: string }) => {
        order.push(`append-success:${executionResult.finished}`);
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
  assert.deepEqual(order, [
    "create:launch-1",
    "started:launch-1",
    "execute:launch-1",
    "append-success:launch-1",
    "success:launch-1"
  ]);
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
      appendFailure: async (_context: { id: string }, error: unknown) => {
        order.push(`append-failure:${error instanceof Error ? error.message : String(error)}`);
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
  assert.deepEqual(order, ["started:launch-2", "append-failure:boom", "failed:boom"]);
});

test("launch template forwards timeout classification and lifecycle hooks", async () => {
  const order: string[] = [];

  const result = await executeOrchestratorLaunch(
    { id: "launch-timeout" },
    {
      createContext: async (input: { id: string }) => ({ id: input.id }),
      appendStarted: async (context: { id: string }) => {
        order.push(`started:${context.id}`);
      },
      appendTimeout: async (_context: { id: string }, error: unknown) => {
        order.push(`timeout:${error instanceof Error ? error.message : String(error)}`);
      },
      execute: async () => {
        throw new Error("deadline");
      },
      classifyFailure: () => "timeout",
      onSuccess: async () => "ok",
      onFailure: async () => "failed"
    }
  );

  assert.equal(result, "failed");
  assert.deepEqual(order, ["started:launch-timeout", "timeout:deadline"]);
});

test("launch template can build a launch facade from lifecycle callbacks", async () => {
  const order: string[] = [];
  const adapter = createOrchestratorLaunchAdapter({
    createContext: async (input: { id: string }) => ({ id: input.id }),
    appendStarted: async (context: { id: string }) => {
      order.push(`started:${context.id}`);
    },
    execute: async (context: { id: string }) => {
      order.push(`execute:${context.id}`);
      return { id: context.id };
    },
    onSuccess: async (_context: { id: string }, result: { id: string }) => {
      order.push(`success:${result.id}`);
      return result.id;
    },
    onFailure: async () => {
      throw new Error("should not fail");
    }
  });

  const result = await adapter.launch({ id: "launch-3" });

  assert.equal(result, "launch-3");
  assert.deepEqual(order, ["started:launch-3", "execute:launch-3", "success:launch-3"]);
});
