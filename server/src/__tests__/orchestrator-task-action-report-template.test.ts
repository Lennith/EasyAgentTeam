import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOrchestratorTaskReportActionResult,
  buildOrchestratorTaskReportAppliedEventPayload
} from "../services/orchestrator/shared/task-action-report-template.js";

test("task report event payload helper normalizes updated ids and rejected count", () => {
  const payload = buildOrchestratorTaskReportAppliedEventPayload({
    fromAgent: "dev",
    appliedTaskIds: ["task-a", "task-b"],
    rejectedResults: [{ taskId: "task-missing", reasonCode: "TASK_NOT_FOUND" }],
    includeRejectedResults: true,
    extraPayload: {
      actionType: "TASK_REPORT"
    }
  });

  assert.deepEqual(payload, {
    fromAgent: "dev",
    appliedTaskIds: ["task-a", "task-b"],
    updatedTaskIds: ["task-a", "task-b"],
    rejectedCount: 1,
    rejectedResults: [{ taskId: "task-missing", reasonCode: "TASK_NOT_FOUND" }],
    actionType: "TASK_REPORT"
  });
});

test("task report action result helper keeps partialApplied derived from rejected list", () => {
  const accepted = buildOrchestratorTaskReportActionResult({
    actionType: "TASK_REPORT",
    appliedTaskIds: ["task-a"],
    rejectedResults: [],
    extraResult: {
      requestId: "req-1"
    }
  });
  const partial = buildOrchestratorTaskReportActionResult({
    actionType: "TASK_REPORT",
    appliedTaskIds: ["task-a"],
    rejectedResults: [{ task_id: "task-b", reason_code: "TASK_NOT_FOUND", reason: "missing" }]
  });

  assert.equal(accepted.partialApplied, false);
  assert.equal(accepted.requestId, "req-1");
  assert.equal(partial.partialApplied, true);
  assert.deepEqual(partial.rejectedResults, [{ task_id: "task-b", reason_code: "TASK_NOT_FOUND", reason: "missing" }]);
});
