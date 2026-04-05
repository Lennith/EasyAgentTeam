import assert from "node:assert/strict";
import { test } from "node:test";
import {
  categorizeFailure,
  deriveConstraintUpdates,
  judgeRuntimeConvergence
} from "../campaign/observe-run.mjs";

test("runtime convergence judge returns pass when done count increases and no blockers", () => {
  const judged = judgeRuntimeConvergence({
    runStatus: "running",
    beforeRuntime: { tasks: [{ taskId: "a", state: "READY" }] },
    finalRuntime: {
      tasks: [
        { taskId: "a", state: "DONE" },
        { taskId: "b", state: "DONE" }
      ]
    }
  });
  assert.equal(judged.status, "pass");
  assert.equal(judged.progressed, true);
  assert.equal(judged.blocker_count, 0);
});

test("runtime convergence judge returns fail when blocker exists", () => {
  const judged = judgeRuntimeConvergence({
    runStatus: "failed",
    beforeRuntime: { tasks: [{ taskId: "a", state: "READY" }] },
    finalRuntime: {
      tasks: [
        { taskId: "a", state: "DONE" },
        { taskId: "b", state: "BLOCKED" }
      ]
    }
  });
  assert.equal(judged.status, "fail");
  assert.equal(judged.blocker_count, 1);
});

test("failure categorize marks backend suspect when HTTP 500 appears", () => {
  const category = categorizeFailure({
    stage: "apply",
    error: {
      code: "HTTP_REQUEST_FAILED",
      message: "request failed",
      details: { status: 500 }
    }
  });
  assert.equal(category, "backend_suspect");
  const updates = deriveConstraintUpdates({ category, stage: "apply" });
  assert.equal(updates.length > 0, true);
});
