import assert from "node:assert/strict";
import test from "node:test";
import {
  collectOrchestratorUnreadyDependencyIds,
  isOrchestratorDependencyResolved,
  requiresOrchestratorReadyDependencies
} from "../services/orchestrator/shared/dependency-gate.js";

test("dependency gate marks DONE/CANCELED as resolved", () => {
  assert.equal(isOrchestratorDependencyResolved("DONE"), true);
  assert.equal(isOrchestratorDependencyResolved("CANCELED"), true);
  assert.equal(isOrchestratorDependencyResolved("READY"), false);
  assert.equal(isOrchestratorDependencyResolved(undefined), false);
});

test("dependency gate collects unresolved dependency ids", () => {
  const stateByTaskId = new Map<string, string>([
    ["task_a", "DONE"],
    ["task_b", "IN_PROGRESS"],
    ["task_c", "CANCELED"]
  ]);
  const unresolved = collectOrchestratorUnreadyDependencyIds(
    ["task_a", "task_b", "task_missing", "task_c"],
    (dependencyId) => stateByTaskId.get(dependencyId)
  );
  assert.deepEqual(unresolved, ["task_b", "task_missing"]);
});

test("dependency gate requires ready dependencies except BLOCKED_DEP/CANCELED by default", () => {
  assert.equal(requiresOrchestratorReadyDependencies("IN_PROGRESS"), true);
  assert.equal(requiresOrchestratorReadyDependencies("DONE"), true);
  assert.equal(requiresOrchestratorReadyDependencies("BLOCKED_DEP"), false);
  assert.equal(requiresOrchestratorReadyDependencies("CANCELED"), false);
});
