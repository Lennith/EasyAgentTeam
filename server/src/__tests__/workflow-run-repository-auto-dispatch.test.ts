import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  createWorkflowRun,
  createWorkflowTemplate,
  getWorkflowRun
} from "../data/repository/workflow/run-repository.js";

test("workflow run repository persists initial auto dispatch budget and falls back for legacy records", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-run-auto-dispatch-"));

  await createWorkflowTemplate(tempRoot, {
    templateId: "wf_repo_auto_tpl",
    name: "Workflow Repo Auto Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });

  const created = await createWorkflowRun(tempRoot, {
    runId: "wf_repo_auto_run",
    templateId: "wf_repo_auto_tpl",
    name: "Workflow Repo Auto Run",
    workspacePath: tempRoot,
    autoDispatchRemaining: 4,
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" }]
  });
  assert.equal(created.autoDispatchRemaining, 4);
  assert.equal(created.autoDispatchInitialRemaining, 4);

  const runsFile = path.join(tempRoot, "workflows", "runs.json");
  const registry = JSON.parse(await readFile(runsFile, "utf8")) as {
    schemaVersion: string;
    updatedAt: string;
    runs: Array<Record<string, unknown>>;
  };
  assert.equal(Array.isArray(registry.runs), true);
  assert.equal(registry.runs.length, 1);
  registry.runs[0].autoDispatchRemaining = 2;
  delete registry.runs[0].autoDispatchInitialRemaining;
  await writeFile(runsFile, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const reloaded = await getWorkflowRun(tempRoot, "wf_repo_auto_run");
  assert.equal(reloaded?.autoDispatchRemaining, 2);
  assert.equal(reloaded?.autoDispatchInitialRemaining, 2);
});
