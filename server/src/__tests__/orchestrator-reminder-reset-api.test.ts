import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { ensureProjectRuntime, getProjectPaths } from "../data/repository/project/runtime-repository.js";
import { getRoleReminderState, updateRoleReminderState } from "../data/repository/project/role-reminder-repository.js";
import { listEvents } from "../data/repository/project/event-repository.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

async function createBasicProject(
  baseUrl: string,
  workspacePath: string,
  projectId: string,
  role: string
): Promise<void> {
  const createAgentRes = await fetch(`${baseUrl}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: role,
      display_name: role,
      prompt: `Role ${role}`
    })
  });
  assert.equal(createAgentRes.status, 201);

  const createProjectRes = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: projectId,
      name: projectId,
      workspace_path: workspacePath,
      agent_ids: [role]
    })
  });
  assert.equal(createProjectRes.status, 201);
}

test("session create resets role reminder state", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-reminder-reset-create-"));
  const dataRoot = path.join(tempRoot, "data");
  const role = "reminder_role_create";
  const projectId = "reminderresetcreate";
  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;
  try {
    await createBasicProject(baseUrl, tempRoot, projectId, role);
    const paths = await ensureProjectRuntime(dataRoot, projectId);
    await updateRoleReminderState(paths, projectId, role, {
      reminderCount: 4,
      idleSince: new Date().toISOString(),
      lastRoleState: "IDLE"
    });

    const createSessionRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role })
    });
    assert.equal(createSessionRes.status, 201);

    const reminderState = await getRoleReminderState(paths, projectId, role);
    assert.ok(reminderState);
    assert.equal(reminderState?.reminderCount, 0);
    assert.equal(reminderState?.lastRoleState, "INACTIVE");

    const events = await listEvents(paths);
    const resetEvent = [...events].reverse().find((item) => item.eventType === "ORCHESTRATOR_ROLE_REMINDER_RESET");
    assert.ok(resetEvent);
    assert.equal((resetEvent?.payload as Record<string, unknown>).reason, "session_created");
  } finally {
    await server.close();
  }
});

test("session dismiss and repair reset role reminder state", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-reminder-reset-dismiss-repair-"));
  const dataRoot = path.join(tempRoot, "data");
  const role = "reminder_role_flow";
  const projectId = "reminderresetflow";
  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;
  try {
    await createBasicProject(baseUrl, tempRoot, projectId, role);
    const paths = await ensureProjectRuntime(dataRoot, projectId);
    const createSessionRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role })
    });
    assert.equal(createSessionRes.status, 201);
    const created = (await createSessionRes.json()) as {
      session: { sessionId: string };
    };
    const sessionToken = created.session.sessionId;

    await updateRoleReminderState(paths, projectId, role, {
      reminderCount: 3,
      lastRoleState: "IDLE"
    });
    const dismissRes = await fetch(
      `${baseUrl}/api/projects/${projectId}/sessions/${encodeURIComponent(sessionToken)}/dismiss`,
      {
        method: "POST"
      }
    );
    assert.equal(dismissRes.status, 200);
    let reminderState = await getRoleReminderState(paths, projectId, role);
    assert.equal(reminderState?.reminderCount, 0);
    assert.equal(reminderState?.lastRoleState, "INACTIVE");

    const createSessionRes2 = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, status: "blocked" })
    });
    assert.equal(createSessionRes2.status, 201);
    const created2 = (await createSessionRes2.json()) as {
      session: { sessionId: string };
    };
    const sessionToken2 = created2.session.sessionId;

    await updateRoleReminderState(paths, projectId, role, {
      reminderCount: 2,
      lastRoleState: "IDLE"
    });
    const repairRes = await fetch(
      `${baseUrl}/api/projects/${projectId}/sessions/${encodeURIComponent(sessionToken2)}/repair`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_status: "idle" })
      }
    );
    assert.equal(repairRes.status, 200);
    reminderState = await getRoleReminderState(paths, projectId, role);
    assert.equal(reminderState?.reminderCount, 0);
    assert.equal(reminderState?.lastRoleState, "INACTIVE");

    const finalPaths = getProjectPaths(dataRoot, projectId);
    const events = await listEvents(finalPaths);
    const resetReasons = events
      .filter((item) => item.eventType === "ORCHESTRATOR_ROLE_REMINDER_RESET")
      .map((item) => String((item.payload as Record<string, unknown>).reason));
    assert.ok(resetReasons.includes("session_dismissed"));
    assert.ok(resetReasons.includes("session_repaired"));
  } finally {
    await server.close();
  }
});
