import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

test("message send resolves latest role session and writes route events", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step45-msg-"));
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
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("message send skips dismissed sessions and auto-bootstraps when none usable", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step45-msg-dismiss-"));
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
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("message send rejects reserved or mismatched explicit target session", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step45-msg-target-guard-"));
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
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("message send rejects likely encoding-corrupted content", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step45-msg-encoding-"));
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
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test.skip("message send supports directional discuss round limits from project route config", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step45-msg-clarify-"));
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
    for (const agentId of ["agent_a", "agent_b"]) {
      const seedRes = await fetch(`${baseUrl}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          display_name: agentId,
          prompt: `${agentId} prompt`
        })
      });
      assert.equal(seedRes.status, 201);
    }

    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "msgclarify",
        name: "Message Clarify Test",
        workspace_path: tempRoot,
        agent_ids: ["agent_a", "agent_b"],
        route_table: {
          agent_a: ["agent_b"],
          agent_b: ["agent_a"]
        },
        route_clarification_rounds: {
          agent_a: { agent_b: 3 },
          agent_b: { agent_a: 5 }
        }
      })
    });
    assert.equal(projectRes.status, 201);

    const createAgentASessionRes = await fetch(`${baseUrl}/api/projects/msgclarify/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-a", role: "agent_a" })
    });
    assert.equal(createAgentASessionRes.status, 201);
    const createAgentASessionPayload = (await createAgentASessionRes.json()) as { session: { sessionId: string } };
    const agentASessionId = createAgentASessionPayload.session.sessionId;
    const createAgentBSessionRes = await fetch(`${baseUrl}/api/projects/msgclarify/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-b", role: "agent_b" })
    });
    assert.equal(createAgentBSessionRes.status, 201);

    const sendRes = await fetch(`${baseUrl}/api/projects/msgclarify/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_agent: "agent_a",
        to: { agent: "agent_b", session_id: null },
        content: "Please clarify requirement 3",
        mode: "CHAT",
        message_type: "CLARIFICATION_REQUEST",
        parent_request_id: "dispatch-parent-001",
        task_id: "task-001",
        clarification: {
          thread_id: "clr-task-001-01",
          round: 1,
          clarification_id: "clr-task-001-01-r1-q1",
          max_rounds: 3,
          title: "Need clarity on requirement 3 boundary"
        }
      })
    });
    assert.equal(sendRes.status, 202);
    const sendPayload = (await sendRes.json()) as { messageType: string; taskId?: string | null; buffered?: boolean };
    assert.equal(sendPayload.messageType, "CLARIFICATION_REQUEST");
    assert.equal(sendPayload.taskId, "task-001");
    assert.equal(sendPayload.buffered, true);

    const inboxRes = await fetch(`${baseUrl}/api/projects/msgclarify/inbox/agent_b?limit=20`);
    assert.equal(inboxRes.status, 200);
    const inboxPayload = (await inboxRes.json()) as {
      items: Array<{ type: string; payload: { taskId?: string; clarification?: { threadId?: string; round?: number } } }>;
    };
    assert.equal(inboxPayload.items.length, 0);

    const overLimitRes = await fetch(`${baseUrl}/api/projects/msgclarify/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_agent: "agent_a",
        to: { agent: "agent_b", session_id: null },
        content: "round overflow",
        mode: "CHAT",
        message_type: "CLARIFICATION_REQUEST",
        parent_request_id: "dispatch-parent-001",
        task_id: "task-001",
        clarification: {
          thread_id: "clr-task-001-01",
          round: 4,
          clarification_id: "clr-task-001-01-r4-q1",
          max_rounds: 3
        }
      })
    });
    assert.equal(overLimitRes.status, 409);
    const overLimitPayload = (await overLimitRes.json()) as {
      error_code?: string;
      noticeSent?: boolean;
      reason?: string;
      noticeSessionId?: string | null;
      error?: { code?: string; message?: string };
    };
    assert.equal(overLimitPayload.error_code, "clarification_round_limit_reached");
    assert.equal(overLimitPayload.error?.code, "clarification_round_limit_reached");
    assert.equal(overLimitPayload.noticeSent, true);
    assert.equal(overLimitPayload.noticeSessionId, agentASessionId);
    assert.equal(String(overLimitPayload.error?.message ?? "").includes("route limit"), true);

    const senderInboxRes = await fetch(`${baseUrl}/api/projects/msgclarify/inbox/agent_a?limit=20`);
    assert.equal(senderInboxRes.status, 200);
    const senderInboxPayload = (await senderInboxRes.json()) as {
      items: Array<{ envelope?: { intent?: string }; body?: { messageType?: string; noticeType?: string } }>;
    };
    const latestSenderItem = senderInboxPayload.items[senderInboxPayload.items.length - 1];
    assert.equal(latestSenderItem?.envelope?.intent, "SYSTEM_NOTICE");
    assert.equal(latestSenderItem?.body?.messageType, "SYSTEM_NOTICE");
    assert.equal(latestSenderItem?.body?.noticeType, "CLARIFICATION_ROUND_LIMIT_REACHED");

    const closedThreadRes = await fetch(`${baseUrl}/api/projects/msgclarify/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_agent: "agent_a",
        to: { agent: "agent_b", session_id: null },
        content: "follow-up on closed thread should fail",
        mode: "CHAT",
        message_type: "CLARIFICATION_REPLY",
        task_id: "task-001",
        in_reply_to: "clr-task-001-01-r4-q1",
        clarification: {
          thread_id: "clr-task-001-01",
          round: 2,
          clarification_id: "clr-task-001-01-r2-a1"
        }
      })
    });
    assert.equal(closedThreadRes.status, 409);
    const closedThreadPayload = (await closedThreadRes.json()) as { error_code?: string };
    assert.equal(closedThreadPayload.error_code, "clarification_thread_closed");

    const reverseAllowedRes = await fetch(`${baseUrl}/api/projects/msgclarify/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_agent: "agent_b",
        to: { agent: "agent_a", session_id: null },
        content: "Round 4 reverse direction should pass",
        mode: "CHAT",
        message_type: "CLARIFICATION_REPLY",
        task_id: "task-001",
        in_reply_to: "clr-task-001-01-r3-q1",
        clarification: {
          thread_id: "clr-task-001-01",
          round: 4,
          clarification_id: "clr-task-001-01-r4-a1"
        }
      })
    });
    assert.equal(reverseAllowedRes.status, 201);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test.skip("discuss requests with parent_request_id are buffered before dispatch-round flush", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step45-msg-clarify-buffer-"));
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
    for (const agentId of ["agent_a", "agent_b"]) {
      const seedRes = await fetch(`${baseUrl}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          display_name: agentId,
          prompt: `${agentId} prompt`
        })
      });
      assert.equal(seedRes.status, 201);
    }

    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "msgclarifybuf",
        name: "Message Clarify Buffer Test",
        workspace_path: tempRoot,
        agent_ids: ["agent_a", "agent_b"],
        route_table: {
          agent_a: ["agent_b"],
          agent_b: ["agent_a"]
        }
      })
    });
    assert.equal(projectRes.status, 201);

    const createBufferAgentASessionRes = await fetch(`${baseUrl}/api/projects/msgclarifybuf/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-a", role: "agent_a" })
    });
    assert.equal(createBufferAgentASessionRes.status, 201);
    const createBufferAgentBSessionRes = await fetch(`${baseUrl}/api/projects/msgclarifybuf/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-b", role: "agent_b" })
    });
    assert.equal(createBufferAgentBSessionRes.status, 201);

    for (const idx of [1, 2]) {
      const sendRes = await fetch(`${baseUrl}/api/projects/msgclarifybuf/messages/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_agent: "agent_a",
          to: { agent: "agent_b", session_id: null },
          content: `clarify question ${idx}`,
          mode: "CHAT",
          message_type: "CLARIFICATION_REQUEST",
          parent_request_id: "parent-run-001",
          task_id: "task-001",
          clarification: {
            thread_id: `clr-task-001-0${idx}`,
            round: 1,
            clarification_id: `clr-task-001-0${idx}-r1-q1`,
            max_rounds: 3
          }
        })
      });
      assert.equal(sendRes.status, 202);
      const sendPayload = (await sendRes.json()) as { buffered?: boolean };
      assert.equal(sendPayload.buffered, true);
    }

    const inboxRes = await fetch(`${baseUrl}/api/projects/msgclarifybuf/inbox/agent_b?limit=20`);
    assert.equal(inboxRes.status, 200);
    const inboxPayload = (await inboxRes.json()) as { items: Array<{ type: string }> };
    assert.equal(inboxPayload.items.length, 0);

    const eventsRes = await fetch(`${baseUrl}/api/projects/msgclarifybuf/events`);
    assert.equal(eventsRes.status, 200);
    const raw = await eventsRes.text();
    const events = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { eventType: string; payload: { parentRequestId?: string } });
    const bufferedEvents = events.filter((event) => event.eventType === "CLARIFICATION_REQUEST_BUFFERED");
    assert.equal(bufferedEvents.length, 2);
    const routedEvents = events.filter(
      (event) => event.eventType === "MESSAGE_ROUTED" && event.payload.parentRequestId === "parent-run-001"
    );
    assert.equal(routedEvents.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
