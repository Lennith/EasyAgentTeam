import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

test("project create and orchestrator settings API use enabled+remaining model", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-orch-settings-"));
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
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "orchsettings",
        name: "Orchestrator Settings",
        workspace_path: tempRoot,
        auto_dispatch_enabled: true,
        auto_dispatch_remaining: 7
      })
    });
    assert.equal(createRes.status, 201);

    const getRes = await fetch(`${baseUrl}/api/projects/orchsettings/orchestrator/settings`);
    assert.equal(getRes.status, 200);
    const settings = (await getRes.json()) as {
      auto_dispatch_enabled: boolean;
      auto_dispatch_remaining: number;
    };
    assert.equal(settings.auto_dispatch_enabled, true);
    assert.equal(settings.auto_dispatch_remaining, 7);

    const patchRes = await fetch(`${baseUrl}/api/projects/orchsettings/orchestrator/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auto_dispatch_enabled: false,
        auto_dispatch_remaining: 3
      })
    });
    assert.equal(patchRes.status, 200);
    const patched = (await patchRes.json()) as {
      auto_dispatch_enabled: boolean;
      auto_dispatch_remaining: number;
    };
    assert.equal(patched.auto_dispatch_enabled, false);
    assert.equal(patched.auto_dispatch_remaining, 3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("retired auto_dispatch_limit is rejected on create and routing-config patch", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-orch-retired-"));
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
    const rejectedCreate = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "retiredfield",
        name: "Retired Field",
        workspace_path: tempRoot,
        auto_dispatch_limit: 10
      })
    });
    assert.equal(rejectedCreate.status, 400);

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "retiredfield-ok",
        name: "Retired Field OK",
        workspace_path: tempRoot
      })
    });
    assert.equal(createRes.status, 201);

    const patchRes = await fetch(`${baseUrl}/api/projects/retiredfield-ok/routing-config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_ids: [],
        route_table: {},
        auto_dispatch_limit: 3
      })
    });
    assert.equal(patchRes.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

