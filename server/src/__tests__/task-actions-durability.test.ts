import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

test("task create is durably visible before the next dependent create runs", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-task-durability-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });

  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;
  const projectId = "durabilitycheck";
  const rootTaskId = `${projectId}-root`;
  const taskboardFile = path.join(dataRoot, "projects", projectId, "collab", "state", "taskboard.json");

  try {
    const createProject = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        name: "Durability Check",
        workspace_path: workspacePath
      })
    });
    assert.equal(createProject.status, 201);

    const createLeadTask = await fetch(`${baseUrl}/api/projects/${projectId}/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "task-discuss-lead-plan",
        task_kind: "EXECUTION",
        parent_task_id: rootTaskId,
        root_task_id: rootTaskId,
        title: "Lead discuss plan",
        owner_role: "manager"
      })
    });
    assert.equal(createLeadTask.status, 201);

    const taskboardAfterLead = JSON.parse(await fs.readFile(taskboardFile, "utf8")) as {
      tasks: Array<{ taskId: string; dependencies?: string[] }>;
    };
    assert.equal(
      taskboardAfterLead.tasks.some((task) => task.taskId === "task-discuss-lead-plan"),
      true
    );

    const createDependentTask = await fetch(`${baseUrl}/api/projects/${projectId}/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "task-discuss-arch-b",
        task_kind: "EXECUTION",
        parent_task_id: rootTaskId,
        root_task_id: rootTaskId,
        title: "Architecture response",
        owner_role: "manager",
        dependencies: ["task-discuss-lead-plan"]
      })
    });
    assert.equal(createDependentTask.status, 201);

    const taskboardAfterDependent = JSON.parse(await fs.readFile(taskboardFile, "utf8")) as {
      tasks: Array<{ taskId: string; dependencies?: string[] }>;
    };
    const dependentTask = taskboardAfterDependent.tasks.find((task) => task.taskId === "task-discuss-arch-b");
    assert.ok(dependentTask);
    assert.deepEqual(dependentTask?.dependencies ?? [], ["task-discuss-lead-plan"]);
  } finally {
    await serverHandle.close();
  }
});
