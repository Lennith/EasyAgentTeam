import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createProject, ensureProjectRuntime } from "../data/project-store.js";
import { addSession } from "../data/session-store.js";
import { createTask, listTasks } from "../data/taskboard-store.js";
import { handleTaskAction } from "../services/task-action-service.js";

test("TASK_REPORT accepts owner role report even when ownerSession token is stale", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-task-report-owner-key-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });

  const created = await createProject(dataRoot, {
    projectId: "taskreportownersession",
    name: "Task Report Owner Session",
    workspacePath
  });
  const project = created.project;
  const paths = await ensureProjectRuntime(dataRoot, project.projectId);

  const canonicalSessionId = "019c6cc5-f6cb-7f31-931a-52f3e368c9f7";
  await addSession(paths, project.projectId, {
    sessionId: canonicalSessionId,
    role: "dev_1",
    status: "running",
    provider: "codex",
    providerSessionId: canonicalSessionId
  });

  const taskId = "task-1771340915111-guw6k8-dev1-r1";
  await createTask(paths, project.projectId, {
    taskId,
    taskKind: "EXECUTION",
    parentTaskId: `${project.projectId}-root`,
    rootTaskId: `${project.projectId}-root`,
    title: "CN examples",
    ownerRole: "dev_1",
    ownerSession: "pending-dev_1-3ogptalk",
    state: "DISPATCHED"
  });

  const progressPath = path.join(workspacePath, "Agents", "dev_1", "progress.md");
  await fs.mkdir(path.dirname(progressPath), { recursive: true });
  await fs.writeFile(
    progressPath,
    ["# Progress - dev_1", "", "status: DONE", `task: ${taskId}`, "changed: src/example.ts"].join("\n"),
    "utf8"
  );

  const reportResult = await handleTaskAction(dataRoot, project, paths, {
    action_type: "TASK_REPORT",
    from_agent: "dev_1",
    from_session_id: canonicalSessionId,
    summary: "done",
    results: [{ task_id: taskId, outcome: "DONE", summary: "implemented" }]
  });

  assert.equal(reportResult.success, true);
  assert.equal(reportResult.actionType, "TASK_REPORT");
  const tasks = await listTasks(paths, project.projectId);
  const task = tasks.find((item) => item.taskId === taskId);
  assert.equal(task?.state, "DONE");
});
