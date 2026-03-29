import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { getWorkflowRepositoryBundle } from "../data/repository/workflow-repository-bundle.js";
import { createWorkflowRun, createWorkflowTemplate, getWorkflowRun } from "../data/workflow-store.js";
import { listWorkflowRunEvents, listWorkflowSessions, upsertWorkflowSession } from "../data/workflow-run-store.js";
import type { WorkflowRunRecord, WorkflowRunRuntimeState } from "../domain/models.js";
import type { ProviderRegistry } from "../services/provider-runtime.js";
import { WorkflowRunLifecycleService } from "../services/orchestrator/workflow-run-lifecycle-service.js";
import { convergeWorkflowRuntime } from "../services/orchestrator/runtime/workflow-runtime-kernel.js";

function createWorkflowRunHelpers(dataRoot: string) {
  const repositories = getWorkflowRepositoryBundle(dataRoot);
  const loadRunOrThrow = async (runId: string): Promise<WorkflowRunRecord> => {
    const run = await repositories.workflowRuns.getRun(runId);
    if (!run) {
      throw new Error(`run '${runId}' not found`);
    }
    return run;
  };
  const readConvergedRuntime = async (run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState> => {
    const storedRuntime = run.runtime ?? (await repositories.workflowRuns.readRuntime(run.runId));
    return convergeWorkflowRuntime(run, storedRuntime).runtime;
  };
  return {
    repositories,
    loadRunOrThrow,
    readConvergedRuntime,
    runWorkflowTransaction: <T>(runId: string, operation: () => Promise<T>) =>
      repositories.runWithResolvedScope(runId, async () => operation())
  };
}

test("workflow run lifecycle service starts and stops runs with session cancel cleanup", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-run-lifecycle-"));
  const runId = "wf_run_lifecycle";

  await createWorkflowTemplate(tempRoot, {
    templateId: "wf_run_lifecycle_tpl",
    name: "Workflow Run Lifecycle Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowRun(tempRoot, {
    runId,
    templateId: "wf_run_lifecycle_tpl",
    name: "Workflow Run Lifecycle Run",
    workspacePath: tempRoot,
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" }]
  });
  await upsertWorkflowSession(tempRoot, runId, {
    sessionId: "lead-session-01",
    role: "lead",
    status: "running",
    provider: "minimax",
    providerSessionId: "provider-session-01"
  });

  const activeRunIds = new Set<string>();
  const clearedRunIds: string[] = [];
  const clearedStableWindowRunIds: string[] = [];
  const canceledSessions: string[] = [];
  const helpers = createWorkflowRunHelpers(tempRoot);
  const providerRegistry = {
    cancelSession: (_providerId: string | undefined, sessionId: string) => {
      canceledSessions.push(sessionId);
      return true;
    }
  } as unknown as ProviderRegistry;

  const service = new WorkflowRunLifecycleService({
    repositories: helpers.repositories,
    providerRegistry,
    activeRunIds,
    clearRunScopedState: (currentRunId) => {
      clearedRunIds.push(currentRunId);
    },
    clearAutoFinishStableWindow: (currentRunId) => {
      clearedStableWindowRunIds.push(currentRunId);
    },
    loadRunOrThrow: helpers.loadRunOrThrow,
    readConvergedRuntime: helpers.readConvergedRuntime,
    runWorkflowTransaction: helpers.runWorkflowTransaction
  });

  const started = await service.startRun(runId);
  assert.equal(started.status, "running");
  assert.equal(started.active, true);
  assert.equal(activeRunIds.has(runId), true);
  assert.deepEqual(clearedStableWindowRunIds, [runId]);

  const stopped = await service.stopRun(runId);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.active, false);
  assert.equal(activeRunIds.has(runId), false);
  assert.deepEqual(clearedRunIds, [runId]);
  assert.deepEqual(canceledSessions, ["provider-session-01"]);

  const runAfter = await getWorkflowRun(tempRoot, runId);
  assert.equal(runAfter?.status, "stopped");
  const sessions = await listWorkflowSessions(tempRoot, runId);
  assert.equal(sessions[0]?.status, "idle");

  const events = await listWorkflowRunEvents(tempRoot, runId);
  assert.equal(
    events.some((event) => event.eventType === "RUN_STOP_SESSION_CANCEL"),
    true
  );
});
