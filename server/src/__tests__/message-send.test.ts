import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

test("message send resolves latest role session and writes route events", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step45-msg-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "messagetest",
        name: "Message Test",
        workspace_path: tempRoot
      })
    });
    assert.equal(projectRes.status, 201);

    const createSessionRes = await fetch(`${baseUrl}/api/projects/messagetest/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-a", role: "dev_backend" })
    });
    assert.equal(createSessionRes.status, 201);
    const createSessionPayload = (await createSessionRes.json()) as {
      session: { sessionId: string };
    };
    const resolvedDevSessionId = createSessionPayload.session.sessionId;

    const sendRes = await fetch(`${baseUrl}/api/projects/messagetest/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: { agent: "dev_backend", session_id: null },
        content: "please continue",
        mode: "CHAT"
      })
    });
    assert.equal(sendRes.status, 201);
    const sendPayload = (await sendRes.json()) as { resolvedSessionId: string; requestId: string };
    assert.equal(sendPayload.resolvedSessionId, resolvedDevSessionId);
    assert.ok(sendPayload.requestId);

    const inboxRes = await fetch(`${baseUrl}/api/projects/messagetest/inbox/dev_backend?limit=1`);
    assert.equal(inboxRes.status, 200);
    const inboxPayload = (await inboxRes.json()) as {
      items: Array<{ envelope?: { correlation?: { request_id?: string } } }>;
    };
    assert.equal(inboxPayload.items.length, 1);
    assert.equal(inboxPayload.items[0].envelope?.correlation?.request_id, sendPayload.requestId);

    const eventsRes = await fetch(`${baseUrl}/api/projects/messagetest/events`);
    assert.equal(eventsRes.status, 200);
    const raw = await eventsRes.text();
    const events = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { eventType: string });
    const types = new Set(events.map((event) => event.eventType));
    assert.equal(types.has("USER_MESSAGE_RECEIVED"), true);
    assert.equal(types.has("MESSAGE_ROUTED"), true);
  } finally {
    await serverHandle.close();
  }
});

test("message send skips dismissed sessions and auto-bootstraps when none usable", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step45-msg-dismiss-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "msgdismiss",
        name: "Message Dismiss Test",
        workspace_path: tempRoot
      })
    });
    assert.equal(projectRes.status, 201);

    const createSessionRes = await fetch(`${baseUrl}/api/projects/msgdismiss/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-a", role: "dev_backend" })
    });
    assert.equal(createSessionRes.status, 201);
    const createSessionPayload = (await createSessionRes.json()) as { session: { sessionId: string } };
    const devSessionId = createSessionPayload.session.sessionId;

    const dismissBRes = await fetch(`${baseUrl}/api/projects/msgdismiss/sessions/${devSessionId}/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "test" })
    });
    assert.equal(dismissBRes.status, 200);

    const firstSendRes = await fetch(`${baseUrl}/api/projects/msgdismiss/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: { agent: "dev_backend", session_id: null },
        content: "continue from non-dismissed",
        mode: "CHAT"
      })
    });
    assert.equal(firstSendRes.status, 201);
    const firstSendPayload = (await firstSendRes.json()) as { resolvedSessionId: string };
    assert.notEqual(firstSendPayload.resolvedSessionId, devSessionId);

    const secondSendRes = await fetch(`${baseUrl}/api/projects/msgdismiss/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: { agent: "dev_backend", session_id: null },
        content: "should auto bootstrap",
        mode: "CHAT"
      })
    });
    assert.equal(secondSendRes.status, 201);
    const secondSendPayload = (await secondSendRes.json()) as { resolvedSessionId: string };
    assert.equal(secondSendPayload.resolvedSessionId, firstSendPayload.resolvedSessionId);
    assert.equal(secondSendPayload.resolvedSessionId.startsWith("session-dev_backend-"), true);
  } finally {
    await serverHandle.close();
  }
});

test("message send rejects reserved or mismatched explicit target session", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step45-msg-target-guard-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "msgtargetguard",
        name: "Message Target Guard",
        workspace_path: tempRoot
      })
    });
    assert.equal(projectRes.status, 201);

    const devSessionRes = await fetch(`${baseUrl}/api/projects/msgtargetguard/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-dev", role: "dev_backend" })
    });
    assert.equal(devSessionRes.status, 201);
    const qaSessionRes = await fetch(`${baseUrl}/api/projects/msgtargetguard/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-qa", role: "qa_guard" })
    });
    assert.equal(qaSessionRes.status, 201);
    const qaSessionPayload = (await qaSessionRes.json()) as { session: { sessionId: string } };
    const qaSessionId = qaSessionPayload.session.sessionId;

    const reservedRes = await fetch(`${baseUrl}/api/projects/msgtargetguard/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_agent: "manager",
        to: { agent: "dev_backend", session_id: "dashboard-ui" },
        content: "reserved target should fail",
        mode: "CHAT"
      })
    });
    assert.equal(reservedRes.status, 409);
    const reservedPayload = (await reservedRes.json()) as { error_code?: string };
    assert.equal(reservedPayload.error_code, "invalid_target_session_reserved");

    const mismatchRes = await fetch(`${baseUrl}/api/projects/msgtargetguard/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_agent: "manager",
        to: { agent: "dev_backend", session_id: qaSessionId },
        content: "role mismatch should fail",
        mode: "CHAT"
      })
    });
    assert.equal(mismatchRes.status, 409);
    const mismatchPayload = (await mismatchRes.json()) as {
      error_code?: string;
      error?: { details?: { actualRole?: string; expectedRole?: string } };
    };
    assert.equal(mismatchPayload.error_code, "target_session_role_mismatch");
    assert.equal(mismatchPayload.error?.details?.actualRole, "qa_guard");
    assert.equal(mismatchPayload.error?.details?.expectedRole, "dev_backend");
  } finally {
    await serverHandle.close();
  }
});

test("message send rejects likely encoding-corrupted content", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step45-msg-encoding-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "msgencoding",
        name: "Message Encoding Guard",
        workspace_path: tempRoot
      })
    });
    assert.equal(projectRes.status, 201);

    const createDevSessionRes = await fetch(`${baseUrl}/api/projects/msgencoding/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-dev", role: "dev_backend" })
    });
    assert.equal(createDevSessionRes.status, 201);
    const createDevSessionPayload = (await createDevSessionRes.json()) as { session: { sessionId: string } };
    const devSessionId = createDevSessionPayload.session.sessionId;

    const rejectedRes = await fetch(`${baseUrl}/api/projects/msgencoding/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_agent: "manager",
        to: { agent: "dev_backend", session_id: devSessionId },
        content: "?? D:/work/SensorCalibration/PxSensorCalibrationAS/app ??????????",
        mode: "CHAT"
      })
    });
    assert.equal(rejectedRes.status, 400);
    const rejectedPayload = (await rejectedRes.json()) as { error_code?: string };
    assert.equal(rejectedPayload.error_code, "MESSAGE_ENCODING_INVALID");
  } finally {
    await serverHandle.close();
  }
});
