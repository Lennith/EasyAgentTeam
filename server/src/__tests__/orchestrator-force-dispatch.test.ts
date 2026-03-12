import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

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

test("force dispatch returns clear task_not_found for stale task id", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-force-missing-task-"));
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
    await seedAgent(baseUrl, "dev_0");
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "forcedispatch_missing_task",
        name: "Force Dispatch Missing Task",
        workspace_path: tempRoot,
        agent_ids: ["dev_0"]
      })
    });
    assert.equal(projectRes.status, 201);

    const dispatchRes = await fetch(`${baseUrl}/api/projects/forcedispatch_missing_task/orchestrator/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        force: true,
        task_id: "task-old-r0"
      })
    });
    assert.equal(dispatchRes.status, 200);
    const payload = (await dispatchRes.json()) as {
      results: Array<{ outcome: string; reason?: string }>;
    };
    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0]?.outcome, "task_not_found");
    assert.equal(Boolean(payload.results[0]?.reason?.includes("does not exist")), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("force dispatch rejects non-force-dispatchable state with explicit reason", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-force-state-"));
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
    for (const agentId of ["manager", "dev_0"]) {
      await seedAgent(baseUrl, agentId);
    }
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "forcedispatch_blocked_dep",
        name: "Force Dispatch Blocked Dep",
        workspace_path: tempRoot,
        agent_ids: ["dev_0"]
      })
    });
    assert.equal(projectRes.status, 201);
    const createRootRes = await fetch(`${baseUrl}/api/projects/forcedispatch_blocked_dep/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "project-root-forcedispatch_blocked_dep",
        task_kind: "PROJECT_ROOT",
        title: "Project Root",
        owner_role: "manager"
      })
    });
    assert.equal(createRootRes.status, 201);
    const createUserRootRes = await fetch(`${baseUrl}/api/projects/forcedispatch_blocked_dep/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "user-root-1",
        task_kind: "USER_ROOT",
        parent_task_id: "project-root-forcedispatch_blocked_dep",
        title: "User Root",
        owner_role: "manager"
      })
    });
    assert.equal(createUserRootRes.status, 201);
    const createDepRes = await fetch(`${baseUrl}/api/projects/forcedispatch_blocked_dep/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "dep-task-1",
        task_kind: "EXECUTION",
        parent_task_id: "user-root-1",
        root_task_id: "user-root-1",
        title: "Dependency Task",
        owner_role: "dev_0"
      })
    });
    assert.equal(createDepRes.status, 201);
    const createTargetRes = await fetch(`${baseUrl}/api/projects/forcedispatch_blocked_dep/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "blocked-by-dep-task",
        task_kind: "EXECUTION",
        parent_task_id: "user-root-1",
        root_task_id: "user-root-1",
        title: "Blocked Task",
        owner_role: "dev_0",
        dependencies: ["dep-task-1"]
      })
    });
    assert.equal(createTargetRes.status, 201);

    const dispatchRes = await fetch(`${baseUrl}/api/projects/forcedispatch_blocked_dep/orchestrator/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        force: true,
        task_id: "blocked-by-dep-task"
      })
    });
    assert.equal(dispatchRes.status, 200);
    const payload = (await dispatchRes.json()) as {
      results: Array<{ outcome: string; reason?: string }>;
    };
    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0]?.outcome, "task_not_force_dispatchable");
    assert.equal(Boolean(payload.results[0]?.reason?.includes("not force-dispatchable")), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("force dispatch auto-bootstraps session when owner has only dismissed session", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-force-bootstrap-"));
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
    for (const agentId of ["manager", "dev_0"]) {
      await seedAgent(baseUrl, agentId);
    }
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "forcedispatch_bootstrap",
        name: "Force Dispatch Bootstrap",
        workspace_path: tempRoot,
        agent_ids: ["dev_0"]
      })
    });
    assert.equal(projectRes.status, 201);
    const sessionRes = await fetch(`${baseUrl}/api/projects/forcedispatch_bootstrap/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "dev_0",
        session_id: "sess-dev0-old"
      })
    });
    assert.equal(sessionRes.status, 201);
    const sessionPayload = (await sessionRes.json()) as { session: { sessionId: string } };
    const dismissedSessionId = sessionPayload.session.sessionId;

    const dismissRes = await fetch(
      `${baseUrl}/api/projects/forcedispatch_bootstrap/sessions/${dismissedSessionId}/dismiss`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "test bootstrap" })
      }
    );
    assert.equal(dismissRes.status, 200);
    for (const body of [
      {
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "project-root-forcedispatch_bootstrap",
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
        parent_task_id: "project-root-forcedispatch_bootstrap",
        title: "User Root",
        owner_role: "manager"
      },
      {
        action_type: "TASK_CREATE",
        from_agent: "manager",
        from_session_id: "manager-system",
        task_id: "task-dev-r1",
        task_kind: "EXECUTION",
        parent_task_id: "user-root-1",
        root_task_id: "user-root-1",
        title: "Dev Task R1",
        owner_role: "dev_0",
        owner_session: dismissedSessionId
      }
    ]) {
      const res = await fetch(`${baseUrl}/api/projects/forcedispatch_bootstrap/task-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      assert.equal(res.status, 201);
    }
    const routingRes = await fetch(`${baseUrl}/api/projects/forcedispatch_bootstrap/routing-config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_ids: ["dev_0"],
        route_table: { manager: ["dev_0"], dev_0: ["manager"] },
        agent_model_configs: {
          dev_0: { provider_id: "trae", model: "trae-default" }
        }
      })
    });
    assert.equal(routingRes.status, 200);

    const forceDispatchRes = await fetch(`${baseUrl}/api/projects/forcedispatch_bootstrap/orchestrator/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        force: true,
        task_id: "task-dev-r1"
      })
    });
    assert.equal(forceDispatchRes.status, 200);
    const forcePayload = (await forceDispatchRes.json()) as {
      results: Array<{ outcome: string; sessionId: string }>;
    };
    assert.equal(forcePayload.results.length, 1);
    assert.notEqual(forcePayload.results[0]?.outcome, "task_owner_mismatch");
    assert.notEqual(forcePayload.results[0]?.outcome, "session_not_found");
    assert.notEqual(forcePayload.results[0]?.sessionId, dismissedSessionId);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
