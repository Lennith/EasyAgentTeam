import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { getWorkflowRepositoryBundle } from "../data/repository/workflow-repository-bundle.js";
import { createWorkflowRun, createWorkflowTemplate, getWorkflowRun, patchWorkflowRun } from "../data/workflow-store.js";
import { WorkflowRuntimeSupportService } from "../services/orchestrator/workflow-runtime-support-service.js";

test("workflow runtime support service converges runtime and builds active snapshot", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-runtime-support-"));
  const runId = "wf_runtime_support";

  await createWorkflowTemplate(tempRoot, {
    templateId: "wf_runtime_support_tpl",
    name: "Workflow Runtime Support Template",
    tasks: [
      { taskId: "task_a", title: "Task A", ownerRole: "lead" },
      { taskId: "task_b", title: "Task B", ownerRole: "lead", dependencies: ["task_a"] }
    ]
  });
  await createWorkflowRun(tempRoot, {
    runId,
    templateId: "wf_runtime_support_tpl",
    name: "Workflow Runtime Support Run",
    workspacePath: tempRoot,
    tasks: [
      { taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" },
      { taskId: "task_b", title: "Task B", ownerRole: "lead", resolvedTitle: "Task B", dependencies: ["task_a"] }
    ]
  });
  await patchWorkflowRun(tempRoot, runId, { status: "running" });

  const repositories = getWorkflowRepositoryBundle(tempRoot);
  const activeRunIds = new Set<string>([runId]);
  const service = new WorkflowRuntimeSupportService({ repositories, activeRunIds });

  const run = await service.loadRunOrThrow(runId);
  const runtime = await service.ensureRuntime(run);
  assert.equal(runtime.tasks.length, 2);
  assert.equal(runtime.tasks.find((item) => item.taskId === "task_a")?.state, "READY");
  assert.equal(runtime.tasks.find((item) => item.taskId === "task_b")?.state, "BLOCKED_DEP");

  const snapshot = service.buildSnapshot(run, runtime);
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.counters.ready, 1);
  assert.equal(snapshot.counters.blocked, 1);

  const runAfter = await getWorkflowRun(tempRoot, runId);
  assert.ok(runAfter?.runtime);
  assert.equal(runAfter?.runtime?.tasks.find((item) => item.taskId === "task_b")?.state, "BLOCKED_DEP");
});
