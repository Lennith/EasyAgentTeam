import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

async function seedAgent(baseUrl: string, agentId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: agentId,
      display_name: agentId,
      prompt: `${agentId} prompt`
    })
  });
  assert.equal(response.status, 201);
}

test("task assignment message is skipped when ancestor dependency gate is closed", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-assignment-gate-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;

  try {
    for (const agentId of ["manager", "dev_0"]) {
      await seedAgent(baseUrl, agentId);
    }

    const createProjectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "assignment_gate_test",
        name: "Assignment Gate Test",
        workspace_path: tempRoot,
        agent_ids: ["dev_0"]
      })
    });
    assert.equal(createProjectRes.status, 201);

    const createSessionRes = await fetch(`${baseUrl}/api/projects/assignment_gate_test/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "dev_0",
        session_id: "sess-dev-0"
      })
    });
    assert.equal(createSessionRes.status, 201);
    const sessionPayload = (await createSessionRes.json()) as { session: { sessionId: string } };
    const devSessionId = sessionPayload.session.sessionId;

    const taskActions = [
      {
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "project-root-assignment_gate_test",
        task_kind: "PROJECT_ROOT",
        title: "Project Root",
        owner_role: "manager"
      },
      {
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "user-root-1",
        task_kind: "USER_ROOT",
        parent_task_id: "project-root-assignment_gate_test",
        title: "User Root",
        owner_role: "manager"
      },
      {
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "dep-d",
        task_kind: "EXECUTION",
        parent_task_id: "user-root-1",
        root_task_id: "user-root-1",
        title: "Dependency D",
        owner_role: "manager"
      },
      {
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "task-c",
        task_kind: "EXECUTION",
        parent_task_id: "user-root-1",
        root_task_id: "user-root-1",
        title: "Task C",
        owner_role: "dev_0",
        owner_session: devSessionId,
        dependencies: ["dep-d"]
      },
      {
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "task-b",
        task_kind: "EXECUTION",
        parent_task_id: "task-c",
        root_task_id: "user-root-1",
        title: "Task B",
        owner_role: "dev_0",
        owner_session: devSessionId
      },
      {
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "task-a",
        task_kind: "EXECUTION",
        parent_task_id: "task-b",
        root_task_id: "user-root-1",
        title: "Task A",
        owner_role: "dev_0",
        owner_session: devSessionId
      }
    ];

    for (const body of taskActions) {
      const response = await fetch(`${baseUrl}/api/projects/assignment_gate_test/task-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 201);
    }

    const dispatchRes = await fetch(`${baseUrl}/api/projects/assignment_gate_test/orchestrator/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: devSessionId
      })
    });
    assert.equal(dispatchRes.status, 200);
    const payload = (await dispatchRes.json()) as { results: Array<{ outcome: string; taskId?: string }> };
    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0]?.outcome, "no_message");
  } finally {
    await server.close();
  }
});
