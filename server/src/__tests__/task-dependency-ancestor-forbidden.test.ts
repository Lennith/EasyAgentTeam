import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createProject } from "../data/repository/project/runtime-repository.js";
import {
  TaskboardStoreError,
  createTask,
  ensureUserRootTask,
  patchTask
} from "../data/repository/project/taskboard-repository.js";

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

test("createTask rejects dependency whose chain reaches ancestor", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-task-transitive-ancestor-dep-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "transitiveancestordep",
    name: "Transitive Ancestor Dependency Gate",
    workspacePath: tempRoot
  });
  const userRoot = await ensureUserRootTask(created.paths, "transitiveancestordep", {
    taskId: "user-root-1",
    title: "User Root",
    creatorRole: "manager",
    creatorSessionId: "manager-system"
  });

  await createTask(created.paths, "transitiveancestordep", {
    taskId: "task-a",
    taskKind: "EXECUTION",
    parentTaskId: userRoot.taskId,
    rootTaskId: userRoot.taskId,
    title: "Task A",
    ownerRole: "dev"
  });
  await createTask(created.paths, "transitiveancestordep", {
    taskId: "task-b",
    taskKind: "EXECUTION",
    parentTaskId: userRoot.taskId,
    rootTaskId: userRoot.taskId,
    title: "Task B",
    ownerRole: "dev",
    dependencies: ["task-a"]
  });
  await createTask(created.paths, "transitiveancestordep", {
    taskId: "task-c",
    taskKind: "EXECUTION",
    parentTaskId: userRoot.taskId,
    rootTaskId: userRoot.taskId,
    title: "Task C",
    ownerRole: "dev",
    dependencies: ["task-b"]
  });

  await assert.rejects(
    async () => {
      await createTask(created.paths, "transitiveancestordep", {
        taskId: "task-d",
        taskKind: "EXECUTION",
        parentTaskId: "task-a",
        rootTaskId: userRoot.taskId,
        title: "Task D",
        ownerRole: "dev",
        dependencies: ["task-c"]
      });
    },
    (error: unknown) => {
      assert.ok(error instanceof TaskboardStoreError);
      assert.equal(error.code, "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN");
      const details = error.details as
        | {
            transitive_forbidden_dependencies?: Array<{
              dependency_task_id?: string;
              hit_ancestor_task_id?: string;
              dependency_chain?: string[];
            }>;
          }
        | undefined;
      const transitive = details?.transitive_forbidden_dependencies ?? [];
      assert.equal(transitive.length > 0, true);
      assert.equal(transitive[0]?.dependency_task_id, "task-c");
      assert.equal(transitive[0]?.hit_ancestor_task_id, "task-a");
      assert.deepEqual(transitive[0]?.dependency_chain ?? [], ["task-c", "task-b", "task-a"]);
      return true;
    }
  );
});
