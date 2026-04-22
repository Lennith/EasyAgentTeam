import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { getWorkflowRepositoryBundle } from "../data/repository/workflow/repository-bundle.js";
import {
  createWorkflowRun,
  createWorkflowTemplate,
  getWorkflowRun,
  patchWorkflowRun
} from "../data/repository/workflow/run-repository.js";
import { createWorkflowOrchestratorTransientState } from "../services/orchestrator/workflow/workflow-orchestrator-state.js";
import { WorkflowRuntimeSupportService } from "../services/orchestrator/workflow/workflow-runtime-support-service.js";
import { addWorkflowTaskTransition } from "../services/orchestrator/shared/runtime/workflow-runtime-kernel.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

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
  const transientState = createWorkflowOrchestratorTransientState();
  const service = new WorkflowRuntimeSupportService({
    repositories,
    activeRunIds,
    runExclusiveRuntimeMutation: (targetRunId, operation) =>
      transientState.runExclusiveRuntimeMutation(targetRunId, operation)
  });

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

test("workflow runtime support service serializes stale runtime rewrites behind newer mutations", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-runtime-serial-"));
  const runId = "wf_runtime_serial";

  await createWorkflowTemplate(tempRoot, {
    templateId: "wf_runtime_serial_tpl",
    name: "Workflow Runtime Serial Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowRun(tempRoot, {
    runId,
    templateId: "wf_runtime_serial_tpl",
    name: "Workflow Runtime Serial Run",
    workspacePath: tempRoot,
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" }]
  });
  await patchWorkflowRun(tempRoot, runId, { status: "running" });

  const repositories = getWorkflowRepositoryBundle(tempRoot);
  const transientState = createWorkflowOrchestratorTransientState();
  const service = new WorkflowRuntimeSupportService({
    repositories,
    activeRunIds: new Set<string>([runId]),
    runExclusiveRuntimeMutation: (targetRunId, operation) =>
      transientState.runExclusiveRuntimeMutation(targetRunId, operation)
  });

  const initialRun = await service.loadRunOrThrow(runId);
  const initialRuntime = await service.ensureRuntime(initialRun);
  assert.equal(initialRuntime.tasks[0]?.state, "READY");

  let releaseStaleWrite!: () => void;
  const staleReadCaptured = createDeferred<void>();
  const staleWriteReleased = new Promise<void>((resolve) => {
    releaseStaleWrite = resolve;
  });

  const staleRewrite = service.runWorkflowTransaction(runId, async () => {
    const run = await service.loadRunOrThrow(runId);
    const runtime = await service.readConvergedRuntime(run);
    staleReadCaptured.resolve();
    await staleWriteReleased;
    await repositories.workflowRuns.writeRuntime(runId, runtime);
    await repositories.workflowRuns.patchRun(runId, { runtime });
  });

  await staleReadCaptured.promise;

  const freshDoneWrite = service.runWorkflowTransaction(runId, async () => {
    const run = await service.loadRunOrThrow(runId);
    const runtime = await service.readConvergedRuntime(run);
    const task = runtime.tasks.find((item) => item.taskId === "task_a");
    assert.ok(task);
    addWorkflowTaskTransition(runtime, task, "DONE", "fresh completion");
    await repositories.workflowRuns.writeRuntime(runId, runtime);
    await repositories.workflowRuns.patchRun(runId, { runtime });
  });

  releaseStaleWrite();
  await Promise.all([staleRewrite, freshDoneWrite]);

  const runAfter = await getWorkflowRun(tempRoot, runId);
  assert.equal(runAfter?.runtime?.tasks.find((item) => item.taskId === "task_a")?.state, "DONE");
});
