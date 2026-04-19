import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

test("project recovery endpoints return unified dismiss/repair contract and reject running repair", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-session-dismiss-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;

  try {
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "dismiss-process",
        name: "Dismiss Process",
        workspace_path: tempRoot
      })
    });
    assert.equal(projectRes.status, 201);

    const sessionRes = await fetch(`${baseUrl}/api/projects/dismiss-process/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-a", role: "dev_impl", status: "running" })
    });
    assert.equal([200, 201].includes(sessionRes.status), true);
    const sessionPayload = (await sessionRes.json()) as { session: { sessionId: string } };
    const sessionId = sessionPayload.session.sessionId;

    const deniedRepairRes = await fetch(
      `${baseUrl}/api/projects/dismiss-process/sessions/${encodeURIComponent(sessionId)}/repair`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_status: "idle" })
      }
    );
    assert.equal(deniedRepairRes.status, 409);
    const deniedRepairPayload = (await deniedRepairRes.json()) as {
      error_code: string;
      next_action: string | null;
      disabled_reason: string | null;
    };
    assert.equal(deniedRepairPayload.error_code, "SESSION_RECOVERY_ACTION_NOT_ALLOWED");
    assert.equal(deniedRepairPayload.next_action, "Dismiss the running session before attempting repair.");

    const dismissRes = await fetch(
      `${baseUrl}/api/projects/dismiss-process/sessions/${encodeURIComponent(sessionId)}/dismiss`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "dashboard_manual_dismiss" })
      }
    );
    assert.equal(dismissRes.status, 200);
    const payload = (await dismissRes.json()) as {
      action: string;
      previous_status: string;
      next_status: string;
      provider_cancel: { attempted: boolean; confirmed: boolean; result: string };
      process_termination?: {
        attempted: boolean;
        result: string;
        message: string | null;
      } | null;
      mapping_cleared: boolean;
      warnings: string[];
      session: { status: string };
    };
    assert.equal(payload.action, "dismiss");
    assert.equal(payload.previous_status, "running");
    assert.equal(payload.next_status, "dismissed");
    assert.equal(payload.provider_cancel.result, "not_supported");
    assert.equal(payload.session.status, "dismissed");
    assert.equal(typeof payload.process_termination?.attempted, "boolean");
    assert.equal(typeof payload.process_termination?.result, "string");

    const repairRes = await fetch(
      `${baseUrl}/api/projects/dismiss-process/sessions/${encodeURIComponent(sessionId)}/repair`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_status: "idle", reason: "dashboard_manual_repair" })
      }
    );
    assert.equal(repairRes.status, 200);
    const repairPayload = (await repairRes.json()) as {
      action: string;
      previous_status: string;
      next_status: string;
      warnings: string[];
      session: { status: string };
    };
    assert.equal(repairPayload.action, "repair");
    assert.equal(repairPayload.previous_status, "dismissed");
    assert.equal(repairPayload.next_status, "idle");
    assert.equal(repairPayload.session.status, "idle");
  } finally {
    await server.close();
  }
});
