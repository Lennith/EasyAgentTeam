import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createProject, ensureProjectRuntime } from "../data/project-store.js";
import { addSession } from "../data/session-store.js";
import { createTask } from "../data/taskboard-store.js";
import { OrchestratorService } from "../services/orchestrator-service.js";

test("force dispatch rejects task ownerSession that does not match sessionId", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-owner-session-key-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  const created = await createProject(dataRoot, {
    projectId: "ownersessionkey",
    name: "Owner Session Key",
    workspacePath
  });
  const project = created.project;
  const paths = await ensureProjectRuntime(dataRoot, project.projectId);

  const canonicalSessionId = "019c6cc5-f6cb-7f31-931a-52f3e368c9f7";
  await addSession(paths, project.projectId, {
    sessionId: canonicalSessionId,
    role: "dev_2",
    status: "idle",
    provider: "codex",
    providerSessionId: canonicalSessionId
  });

  const taskId = "task-dev1-r1";
  await createTask(paths, project.projectId, {
    taskId,
    taskKind: "EXECUTION",
    parentTaskId: `${project.projectId}-root`,
    rootTaskId: `${project.projectId}-root`,
    title: "Rewrite CN Examples Batch dev_1",
    ownerRole: "dev_1",
    ownerSession: "pending-dev_1-3ogptalk",
    state: "DISPATCHED"
  });

  const orchestrator = new OrchestratorService({
    dataRoot,
    enabled: true,
    intervalMs: 3000,
    maxConcurrentDispatches: 2,
    sessionRunningTimeoutMs: 90 * 10000
  });

  const result = await orchestrator.dispatchProject(project.projectId, {
    mode: "manual",
    sessionId: canonicalSessionId,
    taskId,
    force: true,
    onlyIdle: true
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.outcome, "task_owner_mismatch");
});
