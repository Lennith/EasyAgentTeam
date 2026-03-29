import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

async function seedAgent(baseUrl: string, agentId: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: agentId,
      display_name: agentId,
      prompt: `${agentId} prompt`
    })
  });
  assert.equal(res.status, 201);
}

test("project dispatch prefers deeper runnable task for the same role", async () => {
  const originalCodexCommand = process.env.CODEX_CLI_COMMAND;
  process.env.CODEX_CLI_COMMAND = "missing-codex-cli-for-test";
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-project-leaf-dispatch-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;

  try {
    await seedAgent(baseUrl, "manager");
    await seedAgent(baseUrl, "dev_0");

    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "leaf_priority_project",
        name: "Leaf Priority Project",
        workspace_path: tempRoot,
        agent_ids: ["dev_0"],
        route_table: { manager: ["dev_0"], dev_0: ["manager"] },
        agent_model_configs: {
          dev_0: { provider_id: "codex", model: "codex-test" }
        },
        auto_dispatch_enabled: false,
        auto_dispatch_remaining: 0
      })
    });
    assert.equal(projectRes.status, 201);

    const sessionRes = await fetch(`${baseUrl}/api/projects/leaf_priority_project/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "dev_0", session_id: "sess-dev-0", status: "idle" })
    });
    assert.equal(sessionRes.status, 201);

    const taskBodies = [
      {
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "project-root-leaf-priority-project",
        task_kind: "PROJECT_ROOT",
        title: "Project Root",
        owner_role: "manager"
      },
      {
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "user-root-leaf-priority",
        task_kind: "USER_ROOT",
        parent_task_id: "project-root-leaf-priority-project",
        title: "User Root",
        owner_role: "manager"
      },
      {
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "task_phase_parent",
        task_kind: "EXECUTION",
        parent_task_id: "user-root-leaf-priority",
        root_task_id: "user-root-leaf-priority",
        title: "Phase Parent",
        owner_role: "dev_0"
      },
      {
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "task_leaf_shallow",
        task_kind: "EXECUTION",
        parent_task_id: "user-root-leaf-priority",
        root_task_id: "user-root-leaf-priority",
        title: "Shallow Leaf",
        owner_role: "dev_0"
      },
      {
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "task_leaf_deep",
        task_kind: "EXECUTION",
        parent_task_id: "task_phase_parent",
        root_task_id: "user-root-leaf-priority",
        title: "Deep Leaf",
        owner_role: "dev_0"
      }
    ];

    for (const body of taskBodies) {
      const res = await fetch(`${baseUrl}/api/projects/leaf_priority_project/task-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      assert.equal(res.status, 201);
    }

    const dispatchRes = await fetch(`${baseUrl}/api/projects/leaf_priority_project/orchestrator/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "dev_0",
        only_idle: true,
        max_dispatches: 1
      })
    });
    assert.equal(dispatchRes.status, 200);
    const dispatchPayload = (await dispatchRes.json()) as {
      results: Array<{ outcome: string; taskId?: string }>;
    };
    assert.equal(dispatchPayload.results.length, 1);
    assert.equal(
      dispatchPayload.results[0]?.outcome === "dispatched" || dispatchPayload.results[0]?.outcome === "dispatch_failed",
      true
    );
    assert.equal(dispatchPayload.results[0]?.taskId, "task_leaf_deep");
  } finally {
    await server.close();
    if (originalCodexCommand === undefined) {
      delete process.env.CODEX_CLI_COMMAND;
    } else {
      process.env.CODEX_CLI_COMMAND = originalCodexCommand;
    }
  }
});
