import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { getWorkflowRepositoryBundle } from "../data/repository/workflow/repository-bundle.js";
import { createWorkflowRun, createWorkflowTemplate } from "../data/repository/workflow/run-repository.js";
import { WorkflowOrchestratorStatusService } from "../services/orchestrator/workflow/workflow-orchestrator-status-service.js";

test("workflow orchestrator status service maps loop snapshot and run summaries deterministically", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-status-service-"));

  await createWorkflowTemplate(tempRoot, {
    templateId: "wf_status_tpl",
    name: "Workflow Status Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowRun(tempRoot, {
    runId: "wf_status_run_b",
    templateId: "wf_status_tpl",
    name: "Workflow Status Run B",
    workspacePath: tempRoot,
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" }],
    autoDispatchEnabled: true,
    autoDispatchRemaining: 4,
    holdEnabled: false,
    reminderMode: "backoff"
  });
  await createWorkflowRun(tempRoot, {
    runId: "wf_status_run_a",
    templateId: "wf_status_tpl",
    name: "Workflow Status Run A",
    workspacePath: tempRoot,
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" }],
    autoDispatchEnabled: false,
    autoDispatchRemaining: 1,
    holdEnabled: true,
    reminderMode: "fixed_interval"
  });

  const repositories = getWorkflowRepositoryBundle(tempRoot);
  const service = new WorkflowOrchestratorStatusService({
    repositories,
    activeRunIds: new Set(["wf_status_run_b", "wf_status_run_a"]),
    maxConcurrentDispatches: 3,
    getInFlightDispatchSessionCount: () => 2,
    getLoopSnapshot: () => ({
      enabled: true,
      running: true,
      intervalMs: 9000,
      lastTickAt: "2026-03-28T00:00:00.000Z",
      started: true
    })
  });

  const status = await service.getStatus();
  assert.deepEqual(status.activeRunIds, ["wf_status_run_a", "wf_status_run_b"]);
  assert.equal(status.activeRunCount, 2);
  assert.equal(status.maxConcurrentDispatches, 3);
  assert.equal(status.inFlightDispatchSessions, 2);
  assert.equal(status.intervalMs, 9000);
  assert.equal(status.lastTickAt, "2026-03-28T00:00:00.000Z");
  assert.equal(status.runs?.length, 2);
  assert.equal(
    status.runs?.some((item) => item.runId === "wf_status_run_a" && item.holdEnabled === true),
    true
  );
  assert.equal(
    status.runs?.some(
      (item) =>
        item.runId === "wf_status_run_b" && item.autoDispatchEnabled === true && item.autoDispatchRemaining === 4
    ),
    true
  );
});
