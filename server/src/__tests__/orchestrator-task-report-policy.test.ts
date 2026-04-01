import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOrchestratorDependencyNotReadyHint,
  getOrchestratorTaskReportOutcomeLabel,
  isOrchestratorRetiredTaskReportOutcome,
  isOrchestratorTaskReportableState,
  normalizeOrchestratorTaskReportOutcomeToken,
  parseOrchestratorTaskReportOutcome
} from "../services/orchestrator/shared/task-report-policy.js";

test("task report policy parses stable outcomes and gates MAY_BE_DONE by option", () => {
  assert.equal(parseOrchestratorTaskReportOutcome("IN_PROGRESS"), "IN_PROGRESS");
  assert.equal(parseOrchestratorTaskReportOutcome("blocked_dep"), "BLOCKED_DEP");
  assert.equal(parseOrchestratorTaskReportOutcome("MAY_BE_DONE"), null);
  assert.equal(parseOrchestratorTaskReportOutcome("MAY_BE_DONE", { allowMayBeDone: true }), "MAY_BE_DONE");
});

test("task report policy exposes reportable states for runtime updates", () => {
  assert.equal(isOrchestratorTaskReportableState("PLANNED"), true);
  assert.equal(isOrchestratorTaskReportableState("MAY_BE_DONE"), true);
  assert.equal(isOrchestratorTaskReportableState("DONE"), false);
  assert.equal(isOrchestratorTaskReportableState("CANCELED"), false);
});

test("task report policy builds dependency-not-ready hint with task and dependency ids", () => {
  const hint = buildOrchestratorDependencyNotReadyHint("task-1", ["dep-a", "dep-b"]);
  assert.equal(hint.includes("task-1"), true);
  assert.equal(hint.includes("dep-a, dep-b"), true);
  assert.equal(hint.includes("DONE/CANCELED"), true);
});

test("task report policy exposes retired outcome detection and shared outcome labels", () => {
  assert.equal(normalizeOrchestratorTaskReportOutcomeToken(" blocked_dep "), "BLOCKED_DEP");
  assert.equal(isOrchestratorRetiredTaskReportOutcome("partial"), true);
  assert.equal(isOrchestratorRetiredTaskReportOutcome("DONE"), false);
  assert.equal(getOrchestratorTaskReportOutcomeLabel(), "IN_PROGRESS|BLOCKED_DEP|DONE|CANCELED");
  assert.equal(
    getOrchestratorTaskReportOutcomeLabel({ allowMayBeDone: true }),
    "IN_PROGRESS|BLOCKED_DEP|DONE|CANCELED|MAY_BE_DONE"
  );
});
