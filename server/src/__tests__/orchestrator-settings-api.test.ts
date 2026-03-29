import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

test("project create and orchestrator settings API use enabled+remaining model", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-orch-settings-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;

  try {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "orchsettings",
        name: "Orchestrator Settings",
        workspace_path: tempRoot,
        auto_dispatch_enabled: true,
        auto_dispatch_remaining: 7,
        hold_enabled: true,
        reminder_mode: "fixed_interval"
      })
    });
    assert.equal(createRes.status, 201);

    const getRes = await fetch(`${baseUrl}/api/projects/orchsettings/orchestrator/settings`);
    assert.equal(getRes.status, 200);
    const settings = (await getRes.json()) as {
      auto_dispatch_enabled: boolean;
      auto_dispatch_remaining: number;
      hold_enabled: boolean;
      reminder_mode: "backoff" | "fixed_interval";
    };
    assert.equal(settings.auto_dispatch_enabled, true);
    assert.equal(settings.auto_dispatch_remaining, 7);
    assert.equal(settings.hold_enabled, true);
    assert.equal(settings.reminder_mode, "fixed_interval");

    const patchRes = await fetch(`${baseUrl}/api/projects/orchsettings/orchestrator/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auto_dispatch_enabled: false,
        auto_dispatch_remaining: 3,
        hold_enabled: false,
        reminder_mode: "backoff"
      })
    });
    assert.equal(patchRes.status, 200);
    const patched = (await patchRes.json()) as {
      auto_dispatch_enabled: boolean;
      auto_dispatch_remaining: number;
      hold_enabled: boolean;
      reminder_mode: "backoff" | "fixed_interval";
    };
    assert.equal(patched.auto_dispatch_enabled, false);
    assert.equal(patched.auto_dispatch_remaining, 3);
    assert.equal(patched.hold_enabled, false);
    assert.equal(patched.reminder_mode, "backoff");

    const invalidPatch = await fetch(`${baseUrl}/api/projects/orchsettings/orchestrator/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reminder_mode: "bad_mode"
      })
    });
    assert.equal(invalidPatch.status, 400);
  } finally {
    await server.close();
  }
});

test("retired auto_dispatch_limit is rejected on create and routing-config patch", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-orch-retired-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;

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
    await server.close();
  }
});
