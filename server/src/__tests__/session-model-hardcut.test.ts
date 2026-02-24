import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

test("sessions API exposes sessionId only (no sessionKey/providerSessionId)", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-session-hardcut-"));
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
        project_id: "session-hardcut",
        name: "Session Hardcut",
        workspace_path: tempRoot
      })
    });
    assert.equal(projectRes.status, 201);

    const createRes = await fetch(`${baseUrl}/api/projects/session-hardcut/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "dev_impl", session_id: "legacy-token-ignored" })
    });
    assert.equal(createRes.status, 201);
    const createdPayload = (await createRes.json()) as {
      session: Record<string, unknown>;
      status: string;
    };
    assert.equal(typeof createdPayload.session.sessionId, "string");
    assert.equal((createdPayload.session.sessionId as string).length > 0, true);
    assert.equal("sessionKey" in createdPayload.session, false);
    assert.equal("providerSessionId" in createdPayload.session, false);
    assert.equal(createdPayload.status, "idle");

    const listRes = await fetch(`${baseUrl}/api/projects/session-hardcut/sessions`);
    assert.equal(listRes.status, 200);
    const listPayload = (await listRes.json()) as { items: Array<Record<string, unknown>> };
    assert.equal(listPayload.items.length, 1);
    assert.equal(typeof listPayload.items[0].sessionId, "string");
    assert.equal("sessionKey" in listPayload.items[0], false);
    assert.equal("providerSessionId" in listPayload.items[0], false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("dispatch rejects mismatched role + session_id to prevent misrouting", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-session-role-check-"));
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
        project_id: "session-role-check",
        name: "Session Role Check",
        workspace_path: tempRoot
      })
    });
    assert.equal(projectRes.status, 201);

    const devSessionRes = await fetch(`${baseUrl}/api/projects/session-role-check/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "dev_impl" })
    });
    assert.equal(devSessionRes.status, 201);
    const devPayload = (await devSessionRes.json()) as { session: { sessionId: string } };
    const devSessionId = devPayload.session.sessionId;

    const pmSessionRes = await fetch(`${baseUrl}/api/projects/session-role-check/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "pm_owner" })
    });
    assert.equal(pmSessionRes.status, 201);
    const pmPayload = (await pmSessionRes.json()) as { session: { sessionId: string } };
    const pmSessionId = pmPayload.session.sessionId;
    assert.notEqual(devSessionId, pmSessionId);

    const dispatchRes = await fetch(`${baseUrl}/api/projects/session-role-check/orchestrator/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "dev_impl",
        session_id: pmSessionId,
        force: false
      })
    });
    assert.equal(dispatchRes.status, 409);
    const dispatchPayload = (await dispatchRes.json()) as { error?: { code?: string } };
    assert.equal(dispatchPayload.error?.code, "SESSION_ROLE_MISMATCH");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
