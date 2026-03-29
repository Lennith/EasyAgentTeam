import assert from "node:assert/strict";
import test from "node:test";
import { executeOrchestratorRunner } from "../services/orchestrator/shared/runner-template.js";

test("runner template appends started and success lifecycle in order", async () => {
  const order: string[] = [];
  const result = await executeOrchestratorRunner(
    { runId: "runner-1" },
    {
      createContext: async (input: { runId: string }) => ({ runId: input.runId }),
      execute: async (context: { runId: string }) => {
        order.push(`execute:${context.runId}`);
        return { status: "ok" as const };
      },
      onSuccess: async (_context, executionResult) => executionResult.status,
      onFailure: async () => "failed"
    },
    {
      appendStarted: async (context: { runId: string }) => {
        order.push(`started:${context.runId}`);
      },
      appendSuccess: async () => {
        order.push("success");
      }
    }
  );

  assert.equal(result, "ok");
  assert.deepEqual(order, ["started:runner-1", "execute:runner-1", "success"]);
});

test("runner template routes timeout classification through timeout lifecycle", async () => {
  const order: string[] = [];
  const result = await executeOrchestratorRunner(
    { runId: "runner-timeout" },
    {
      createContext: async (input: { runId: string }) => ({ runId: input.runId }),
      execute: async () => {
        throw new Error("timeout");
      },
      classifyFailure: () => "timeout",
      onSuccess: async () => "ok",
      onFailure: async (_context, error) => `failed:${error instanceof Error ? error.message : String(error)}`
    },
    {
      appendStarted: async () => {
        order.push("started");
      },
      appendTimeout: async () => {
        order.push("timeout");
      }
    }
  );

  assert.equal(result, "failed:timeout");
  assert.deepEqual(order, ["started", "timeout"]);
});

test("runner template supports escalated terminal handling", async () => {
  const order: string[] = [];
  const result = await executeOrchestratorRunner(
    { runId: "runner-escalated" },
    {
      createContext: async (input: { runId: string }) => ({ runId: input.runId }),
      execute: async () => {
        throw new Error("boom");
      },
      classifyFailure: () => "escalated",
      onSuccess: async () => "ok",
      onFailure: async () => "failed",
      onEscalated: async () => "escalated"
    },
    {
      appendStarted: async () => {
        order.push("started");
      },
      appendEscalated: async () => {
        order.push("escalated");
      }
    }
  );

  assert.equal(result, "escalated");
  assert.deepEqual(order, ["started", "escalated"]);
});
