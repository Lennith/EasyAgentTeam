import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OrchestratorKernel,
  buildOrchestratorContextSessionKey
} from "../services/orchestrator/shared/kernel/orchestrator-kernel.js";
import { OrchestratorSingleFlightGate } from "../services/orchestrator/shared/kernel/single-flight.js";

test("OrchestratorKernel runs contexts in deterministic order", async () => {
  const kernel = new OrchestratorKernel();
  const logs: string[] = [];
  await kernel.runTick({
    listContexts: async () => ["context-a", "context-b", "context-c"],
    tickContext: async (context) => {
      logs.push(`start:${context}`);
      await Promise.resolve();
      logs.push(`end:${context}`);
    }
  });
  assert.deepEqual(logs, [
    "start:context-a",
    "end:context-a",
    "start:context-b",
    "end:context-b",
    "start:context-c",
    "end:context-c"
  ]);
});

test("buildOrchestratorContextSessionKey scopes session id by context", () => {
  assert.equal(buildOrchestratorContextSessionKey("project-1", "session-1"), "project-1::session-1");
});

test("OrchestratorSingleFlightGate supports acquire/release and prune", () => {
  const gate = new OrchestratorSingleFlightGate();
  assert.equal(gate.tryAdd("a"), true);
  assert.equal(gate.tryAdd("a"), false);
  gate.add("b");
  gate.add("run-1::session-1");
  gate.add("run-2::session-2");
  assert.equal(gate.has("a"), true);
  assert.equal(gate.size, 4);
  gate.prune((key) => key.startsWith("run-1::"));
  assert.deepEqual(gate.snapshot().sort(), ["a", "b", "run-2::session-2"]);
  gate.delete("a");
  assert.equal(gate.has("a"), false);
  gate.clear();
  assert.equal(gate.size, 0);
});
