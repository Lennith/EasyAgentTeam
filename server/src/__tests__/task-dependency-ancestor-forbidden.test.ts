import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createProject } from "../data/project-store.js";
import { TaskboardStoreError, createTask, ensureUserRootTask, patchTask } from "../data/taskboard-store.js";

test("createTask rejects dependency pointing to direct parent", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-task-parent-dep-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "parentdep",
    name: "Parent Dependency Gate",
    workspacePath: tempRoot
  });
  const userRoot = await ensureUserRootTask(created.paths, "parentdep", {
    taskId: "user-root-1",
    title: "User Root",
    creatorRole: "manager",
    creatorSessionId: "manager-system"
  });
  await assert.rejects(
    async () => {
      await createTask(created.paths, "parentdep", {
        taskId: "task-a",
        taskKind: "EXECUTION",
        parentTaskId: userRoot.taskId,
        rootTaskId: userRoot.taskId,
        title: "Task A",
        ownerRole: "dev",
        dependencies: [userRoot.taskId]
      });
    },
    (error: unknown) => {
      assert.ok(error instanceof TaskboardStoreError);
      assert.equal(error.code, "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN");
      return true;
    }
  );
});

test("patchTask rejects dependency pointing to ancestor", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-task-ancestor-dep-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "ancestordep",
    name: "Ancestor Dependency Gate",
    workspacePath: tempRoot
  });
  const userRoot = await ensureUserRootTask(created.paths, "ancestordep", {
    taskId: "user-root-1",
    title: "User Root",
    creatorRole: "manager",
    creatorSessionId: "manager-system"
  });
  await createTask(created.paths, "ancestordep", {
    taskId: "task-parent",
    taskKind: "EXECUTION",
    parentTaskId: userRoot.taskId,
    rootTaskId: userRoot.taskId,
    title: "Parent",
    ownerRole: "dev"
  });
  await createTask(created.paths, "ancestordep", {
    taskId: "task-child",
    taskKind: "EXECUTION",
    parentTaskId: "task-parent",
    rootTaskId: userRoot.taskId,
    title: "Child",
    ownerRole: "dev"
  });

  await assert.rejects(
    async () => {
      await patchTask(created.paths, "ancestordep", "task-child", {
        dependencies: [userRoot.taskId]
      });
    },
    (error: unknown) => {
      assert.ok(error instanceof TaskboardStoreError);
      assert.equal(error.code, "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN");
      return true;
    }
  );
});
