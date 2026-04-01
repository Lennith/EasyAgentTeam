import assert from "node:assert/strict";
import test from "node:test";
import { collectOrchestratorRoleSet, sortOrchestratorRoles } from "../services/orchestrator/shared/role-candidates.js";

test("collectOrchestratorRoleSet merges session/task/mapped roles with trim and dedupe", () => {
  const roles = collectOrchestratorRoleSet({
    sessionRoles: [" dev ", "qa", "", null],
    taskOwnerRoles: ["dev", " architect "],
    mappedRoles: ["qa", "manager", undefined]
  });
  assert.deepEqual(Array.from(roles), ["dev", "qa", "architect", "manager"]);
});

test("collectOrchestratorRoleSet prioritizes explicit role filter", () => {
  const roles = collectOrchestratorRoleSet({
    explicitRole: " lead ",
    sessionRoles: ["dev"],
    taskOwnerRoles: ["qa"],
    mappedRoles: ["manager"]
  });
  assert.deepEqual(Array.from(roles), ["lead"]);
});

test("sortOrchestratorRoles returns locale ordered list", () => {
  assert.deepEqual(sortOrchestratorRoles(new Set(["qa", "dev", "architect"])), ["architect", "dev", "qa"]);
});
