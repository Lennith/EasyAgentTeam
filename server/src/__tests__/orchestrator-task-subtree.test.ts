import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOrchestratorTaskRedispatchSummary,
  buildOrchestratorTaskSubtreePayload
} from "../services/orchestrator/shared/task-subtree.js";

test("task redispatch summary falls back to the previous summary when there are no descendants", () => {
  const taskSubtree = buildOrchestratorTaskSubtreePayload("task_leaf", [
    {
      taskId: "task_leaf",
      parentTaskId: null,
      state: "DONE",
      ownerRole: "dev",
      ownerSession: "session-dev",
      closeReportId: null,
      lastSummary: "draft ready for final report"
    }
  ]);

  const summary = buildOrchestratorTaskRedispatchSummary("DONE", taskSubtree, "draft ready for final report");

  assert.equal(summary, "draft ready for final report");
});

test("task redispatch summary keeps descendant guidance for parent task", () => {
  const taskSubtree = buildOrchestratorTaskSubtreePayload("task_parent", [
    {
      taskId: "task_parent",
      parentTaskId: null,
      state: "IN_PROGRESS",
      ownerRole: "lead",
      ownerSession: "session-lead",
      closeReportId: null,
      lastSummary: "parent waiting on descendants"
    },
    {
      taskId: "task_child",
      parentTaskId: "task_parent",
      state: "DONE",
      ownerRole: "dev",
      ownerSession: "session-dev",
      closeReportId: "report-child",
      lastSummary: "child done"
    }
  ]);

  const summary = buildOrchestratorTaskRedispatchSummary("IN_PROGRESS", taskSubtree, "parent waiting on descendants");

  assert.match(summary, /task_subtree: total=1, unresolved=0, done=1, blocked=0, canceled=0/i);
  assert.match(
    summary,
    /Use task_subtree to decide whether to continue, wait for descendants, or report parent progress/i
  );
});
