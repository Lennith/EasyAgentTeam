import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createProject, ensureProjectRuntime } from "../data/project-store.js";
import { addSession } from "../data/session-store.js";
import { createTask, getTask } from "../data/taskboard-store.js";
import { handleTaskAction } from "../services/task-action-service.js";

test("TASK_REPORT allows owner or creator and supports partial apply", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-task-report-partial-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });

  const created = await createProject(dataRoot, {
    projectId: "taskreportpartial",
    name: "Task Report Partial",
    workspacePath
  });
  const project = created.project;
  const paths = await ensureProjectRuntime(dataRoot, project.projectId);

  const devSessionId = "sess-dev-1";
  await addSession(paths, project.projectId, {
    sessionId: devSessionId,
    sessionKey: devSessionId,
    role: "dev",
    status: "running",
    provider: "codex",
    providerSessionId: devSessionId,
    agentTool: "codex"
  });

  await createTask(paths, project.projectId, {
    taskId: "task-owner-dev",
    taskKind: "EXECUTION",
    parentTaskId: `${project.projectId}-root`,
    rootTaskId: `${project.projectId}-root`,
    title: "Owner task",
    creatorRole: "manager",
    creatorSessionId: "manager-system",
    ownerRole: "dev",
    ownerSession: devSessionId,
    state: "DISPATCHED"
  });

  await createTask(paths, project.projectId, {
    taskId: "task-creator-dev",
    taskKind: "EXECUTION",
    parentTaskId: `${project.projectId}-root`,
    rootTaskId: `${project.projectId}-root`,
    title: "Creator task",
    creatorRole: "dev",
    creatorSessionId: devSessionId,
    ownerRole: "qa",
    ownerSession: "sess-qa-1",
    state: "DISPATCHED"
  });

  await createTask(paths, project.projectId, {
    taskId: "task-no-access",
    taskKind: "EXECUTION",
    parentTaskId: `${project.projectId}-root`,
    rootTaskId: `${project.projectId}-root`,
    title: "No access task",
    creatorRole: "manager",
    creatorSessionId: "manager-system",
    ownerRole: "qa",
    ownerSession: "sess-qa-1",
    state: "DISPATCHED"
  });

  const result = await handleTaskAction(dataRoot, project, paths, {
    action_type: "TASK_REPORT",
    from_agent: "dev",
    from_session_id: devSessionId,
    summary: "batch report",
    results: [
      { task_id: "task-owner-dev", outcome: "DONE", summary: "owner done" },
      { task_id: "task-creator-dev", outcome: "PARTIAL", summary: "creator progress" },
      { task_id: "task-no-access", outcome: "DONE", summary: "should reject" }
    ]
  });

  assert.equal(result.success, true);
  assert.equal(result.actionType, "TASK_REPORT");
  assert.equal(result.partialApplied, true);
  assert.deepEqual(new Set(result.appliedTaskIds ?? []), new Set(["task-owner-dev", "task-creator-dev"]));
  assert.equal((result.rejectedResults ?? []).length, 1);
  assert.equal(result.rejectedResults?.[0]?.task_id, "task-no-access");
  assert.equal(result.rejectedResults?.[0]?.reason_code, "TASK_RESULT_INVALID_TARGET");

  const ownerTask = await getTask(paths, project.projectId, "task-owner-dev");
  const creatorTask = await getTask(paths, project.projectId, "task-creator-dev");
  const deniedTask = await getTask(paths, project.projectId, "task-no-access");

  assert.equal(ownerTask?.state, "DONE");
  assert.equal(creatorTask?.state, "IN_PROGRESS");
  assert.equal(deniedTask?.state, "DISPATCHED");
});

test("TASK_REPORT returns 409 when all reported tasks are unauthorized", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-task-report-all-reject-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });

  const created = await createProject(dataRoot, {
    projectId: "taskreportallreject",
    name: "Task Report All Reject",
    workspacePath
  });
  const project = created.project;
  const paths = await ensureProjectRuntime(dataRoot, project.projectId);

  const devSessionId = "sess-dev-1";
  await addSession(paths, project.projectId, {
    sessionId: devSessionId,
    sessionKey: devSessionId,
    role: "dev",
    status: "running",
    provider: "codex",
    providerSessionId: devSessionId,
    agentTool: "codex"
  });

  await createTask(paths, project.projectId, {
    taskId: "task-no-access",
    taskKind: "EXECUTION",
    parentTaskId: `${project.projectId}-root`,
    rootTaskId: `${project.projectId}-root`,
    title: "No access",
    creatorRole: "manager",
    creatorSessionId: "manager-system",
    ownerRole: "qa",
    ownerSession: "sess-qa-1",
    state: "DISPATCHED"
  });

  await assert.rejects(
    () =>
      handleTaskAction(dataRoot, project, paths, {
        action_type: "TASK_REPORT",
        from_agent: "dev",
        from_session_id: devSessionId,
        summary: "unauthorized",
        results: [{ task_id: "task-no-access", outcome: "DONE", summary: "fail" }]
      }),
    (error: unknown) => {
      const known = error as { code?: string; status?: number; details?: Record<string, unknown> };
      assert.equal(known.code, "TASK_RESULT_INVALID_TARGET");
      assert.equal(known.status, 409);
      const rejected = known.details?.rejectedResults as Array<{ task_id: string }> | undefined;
      assert.equal(Array.isArray(rejected), true);
      assert.equal(rejected?.[0]?.task_id, "task-no-access");
      return true;
    }
  );
});
