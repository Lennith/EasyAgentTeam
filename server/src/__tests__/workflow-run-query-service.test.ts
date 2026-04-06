import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { getWorkflowRepositoryBundle } from "../data/repository/workflow/repository-bundle.js";
import {
  createWorkflowRun,
  createWorkflowTemplate,
  patchWorkflowRun
} from "../data/repository/workflow/run-repository.js";
import type { WorkflowRunRecord, WorkflowRunRuntimeState } from "../domain/models.js";
import { WorkflowRunQueryService } from "../services/orchestrator/workflow/workflow-run-query-service.js";
import { convergeWorkflowRuntime } from "../services/orchestrator/shared/runtime/workflow-runtime-kernel.js";

function createWorkflowRunHelpers(dataRoot: string) {
  const repositories = getWorkflowRepositoryBundle(dataRoot);
  const loadRunOrThrow = async (runId: string): Promise<WorkflowRunRecord> => {
    const run = await repositories.workflowRuns.getRun(runId);
    if (!run) {
      throw new Error(`run '${runId}' not found`);
    }
    return run;
  };
  const ensureRuntime = async (run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState> => {
    const storedRuntime = run.runtime ?? (await repositories.workflowRuns.readRuntime(run.runId));
    const initial = convergeWorkflowRuntime(run, storedRuntime);
    if (!initial.changed) {
      return initial.runtime;
    }
    return repositories.runWithResolvedScope(run.runId, async () => {
      const freshRun = await loadRunOrThrow(run.runId);
      const freshStoredRuntime = freshRun.runtime ?? (await repositories.workflowRuns.readRuntime(freshRun.runId));
      const next = convergeWorkflowRuntime(freshRun, freshStoredRuntime);
      if (next.changed) {
        await repositories.workflowRuns.writeRuntime(freshRun.runId, next.runtime);
        await repositories.workflowRuns.patchRun(freshRun.runId, { runtime: next.runtime });
      }
      return next.runtime;
    });
  };
  return {
    repositories,
    loadRunOrThrow,
    ensureRuntime
  };
}

test("workflow run query service returns runtime, tree, and settings views through one seam", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-run-query-"));
  const runId = "wf_run_query";

  await createWorkflowTemplate(tempRoot, {
    templateId: "wf_run_query_tpl",
    name: "Workflow Run Query Template",
    tasks: [
      { taskId: "task_a", title: "Task A", ownerRole: "lead" },
      { taskId: "task_b", title: "Task B", ownerRole: "lead", parentTaskId: "task_a", dependencies: ["task_a"] }
    ]
  });
  await createWorkflowRun(tempRoot, {
    runId,
    templateId: "wf_run_query_tpl",
    name: "Workflow Run Query Run",
    workspacePath: tempRoot,
    tasks: [
      { taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" },
      {
        taskId: "task_b",
        title: "Task B",
        ownerRole: "lead",
        resolvedTitle: "Task B",
        parentTaskId: "task_a",
        dependencies: ["task_a"]
      }
    ]
  });
  await patchWorkflowRun(tempRoot, runId, {
    status: "running",
    autoDispatchRemaining: 7,
    holdEnabled: false,
    reminderMode: "backoff"
  });

  const activeRunIds = new Set<string>([runId]);
  const helpers = createWorkflowRunHelpers(tempRoot);
  const service = new WorkflowRunQueryService({
    repositories: helpers.repositories,
    activeRunIds,
    loadRunOrThrow: helpers.loadRunOrThrow,
    ensureRuntime: helpers.ensureRuntime
  });

  const runtime = await service.getRunTaskRuntime(runId);
  assert.equal(runtime.runId, runId);
  assert.equal(runtime.active, true);
  assert.equal(runtime.counters.total, 2);
  assert.equal(runtime.counters.ready, 0);
  assert.equal(runtime.counters.inProgress, 1);
  assert.equal(runtime.counters.blocked, 1);

  const tree = await service.getRunTaskTreeRuntime(runId);
  assert.equal(tree.run_id, runId);
  assert.deepEqual(tree.roots, ["task_a"]);
  assert.equal(tree.nodes.length, 2);
  assert.equal(
    tree.edges.some((edge) => edge.from_task_id === "task_a" && edge.to_task_id === "task_b"),
    true
  );

  const settings = await service.getRunOrchestratorSettings(runId);
  assert.equal(settings.auto_dispatch_remaining, 7);
  assert.equal(settings.hold_enabled, false);
  assert.equal(settings.reminder_mode, "backoff");

  const patched = await service.patchRunOrchestratorSettings(runId, {
    autoDispatchEnabled: false,
    autoDispatchRemaining: 2,
    holdEnabled: true,
    reminderMode: "fixed_interval"
  });
  assert.equal(patched.auto_dispatch_enabled, false);
  assert.equal(patched.auto_dispatch_remaining, 2);
  assert.equal(patched.hold_enabled, true);
  assert.equal(patched.reminder_mode, "fixed_interval");
});
