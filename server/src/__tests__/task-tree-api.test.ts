import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

async function createTask(baseUrl: string, projectId: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${baseUrl}/api/projects/${projectId}/task-actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action_type: "TASK_CREATE",
      from_agent: "manager",
      from_session_id: "manager-system",
      ...body
    })
  });
  assert.equal(res.status, 201);
}

test("task-tree supports focus and external dependency edges", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-task-tree-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start test server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "tasktree",
        name: "Task Tree",
        workspace_path: tempRoot
      })
    });
    assert.equal(projectRes.status, 201);

    await createTask(baseUrl, "tasktree", {
      task_id: "project-root-tasktree",
      task_kind: "PROJECT_ROOT",
      title: "Project Root",
      owner_role: "manager"
    });
    await createTask(baseUrl, "tasktree", {
      task_id: "user-root-tasktree",
      task_kind: "USER_ROOT",
      parent_task_id: "project-root-tasktree",
      title: "User Root",
      owner_role: "manager"
    });
    await createTask(baseUrl, "tasktree", {
      task_id: "task-a",
      task_kind: "EXECUTION",
      parent_task_id: "user-root-tasktree",
      root_task_id: "user-root-tasktree",
      title: "Task A",
      owner_role: "dev"
    });
    await createTask(baseUrl, "tasktree", {
      task_id: "task-b",
      task_kind: "EXECUTION",
      parent_task_id: "user-root-tasktree",
      root_task_id: "user-root-tasktree",
      title: "Task B",
      owner_role: "dev",
      dependencies: ["task-a"]
    });

    const focusRes = await fetch(
      `${baseUrl}/api/projects/tasktree/task-tree?focus_task_id=task-b&include_external_dependencies=true`
    );
    assert.equal(focusRes.status, 200);
    const focusPayload = (await focusRes.json()) as {
      focus: { task_id: string; ancestor_ids: string[] };
      nodes: Array<{ task_id: string }>;
      edges: Array<{ edge_type: string; from_task_id: string; to_task_id: string; external: boolean }>;
      stats: { external_dependency_edge_count: number };
    };
    assert.equal(focusPayload.focus.task_id, "task-b");
    assert.equal(focusPayload.focus.ancestor_ids.includes("user-root-tasktree"), true);
    const nodeIds = new Set(focusPayload.nodes.map((item) => item.task_id));
    assert.equal(nodeIds.has("task-b"), true);
    assert.equal(nodeIds.has("task-a"), false);
    const externalDep = focusPayload.edges.find(
      (edge) => edge.edge_type === "DEPENDS_ON" && edge.from_task_id === "task-b" && edge.to_task_id === "task-a"
    );
    assert.ok(externalDep);
    assert.equal(externalDep.external, true);
    assert.equal(focusPayload.stats.external_dependency_edge_count >= 1, true);

    const noExternalRes = await fetch(
      `${baseUrl}/api/projects/tasktree/task-tree?focus_task_id=task-b&include_external_dependencies=false`
    );
    assert.equal(noExternalRes.status, 200);
    const noExternalPayload = (await noExternalRes.json()) as {
      edges: Array<{ edge_type: string; to_task_id: string }>;
    };
    const filtered = noExternalPayload.edges.find(
      (edge) => edge.edge_type === "DEPENDS_ON" && edge.to_task_id === "task-a"
    );
    assert.equal(filtered, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
