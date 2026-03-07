import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createProject } from "../data/project-store.js";
import {
  createTask,
  ensureUserRootTask,
  getTask,
  listRunnableTasksByRole,
  patchTask,
  recomputeRunnableStates
} from "../data/taskboard-store.js";

test("leaf task is blocked when any ancestor dependency is unfinished", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-ancestor-gate-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "ancestorgate",
    name: "Ancestor Gate Test",
    workspacePath: tempRoot
  });

  const userRoot = await ensureUserRootTask(created.paths, "ancestorgate", {
    taskId: "user-root-1",
    title: "User Root",
    creatorRole: "manager",
    creatorSessionId: "manager-system"
  });

  await createTask(created.paths, "ancestorgate", {
    taskId: "dep-d",
    taskKind: "EXECUTION",
    parentTaskId: userRoot.taskId,
    rootTaskId: userRoot.taskId,
    title: "Dependency D",
    ownerRole: "manager",
    state: "PLANNED"
  });

  await createTask(created.paths, "ancestorgate", {
    taskId: "task-c",
    taskKind: "EXECUTION",
    parentTaskId: userRoot.taskId,
    rootTaskId: userRoot.taskId,
    title: "Task C",
    ownerRole: "dev",
    dependencies: ["dep-d"],
    state: "PLANNED"
  });

  await createTask(created.paths, "ancestorgate", {
    taskId: "task-b",
    taskKind: "EXECUTION",
    parentTaskId: "task-c",
    rootTaskId: userRoot.taskId,
    title: "Task B",
    ownerRole: "dev",
    state: "PLANNED"
  });

  await createTask(created.paths, "ancestorgate", {
    taskId: "task-a",
    taskKind: "EXECUTION",
    parentTaskId: "task-b",
    rootTaskId: userRoot.taskId,
    title: "Task A",
    ownerRole: "dev",
    state: "PLANNED"
  });

  await recomputeRunnableStates(created.paths, "ancestorgate");

  const blockedA = await getTask(created.paths, "ancestorgate", "task-a");
  assert.ok(blockedA);
  assert.equal(blockedA.state, "BLOCKED_DEP");

  const runnableBefore = await listRunnableTasksByRole(created.paths, "ancestorgate");
  const devRunnableBefore = runnableBefore.find((row) => row.role === "dev");
  assert.equal(Boolean(devRunnableBefore?.tasks.some((task) => task.taskId === "task-a")), false);

  await patchTask(created.paths, "ancestorgate", "dep-d", { state: "DONE" });
  await recomputeRunnableStates(created.paths, "ancestorgate");

  const readyA = await getTask(created.paths, "ancestorgate", "task-a");
  assert.ok(readyA);
  assert.equal(readyA.state, "READY");

  const runnableAfter = await listRunnableTasksByRole(created.paths, "ancestorgate");
  const devRunnableAfter = runnableAfter.find((row) => row.role === "dev");
  assert.equal(Boolean(devRunnableAfter?.tasks.some((task) => task.taskId === "task-a")), true);
});
