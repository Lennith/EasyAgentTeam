import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

test("agent io timeline includes user message, route, and dispatch events", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-agent-io-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "agentiotimeline",
        name: "Agent IO Timeline",
        workspace_path: tempRoot
      })
    });
    assert.equal(createRes.status, 201);

    const sessionRes = await fetch(`${baseUrl}/api/projects/agentiotimeline/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-pm",
        role: "PM"
      })
    });
    assert.equal([200, 201].includes(sessionRes.status), true);

    const sendRes = await fetch(`${baseUrl}/api/projects/agentiotimeline/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_agent: "manager",
        to: { agent: "PM", session_id: null },
        content: "please reply with product summary",
        mode: "CHAT"
      })
    });
    assert.equal(sendRes.status, 201);
    const sendPayload = (await sendRes.json()) as { requestId: string; messageId: string };

    const runId = "run-test-agent-io-001";

    const dispatchEventRes = await fetch(`${baseUrl}/api/projects/agentiotimeline/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "ORCHESTRATOR_DISPATCH_STARTED",
        source: "manager",
        session_id: "sess-pm",
        payload: {
          requestId: sendPayload.requestId,
          messageId: sendPayload.messageId
        }
      })
    });
    assert.equal(dispatchEventRes.status, 201);

    const dispatchFinishRes = await fetch(`${baseUrl}/api/projects/agentiotimeline/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "ORCHESTRATOR_DISPATCH_FINISHED",
        source: "manager",
        session_id: "sess-pm",
        payload: {
          runId,
          requestId: sendPayload.requestId,
          messageId: sendPayload.messageId,
          exitCode: 0,
          timedOut: false
        }
      })
    });
    assert.equal(dispatchFinishRes.status, 201);

    const timelineRes = await fetch(`${baseUrl}/api/projects/agentiotimeline/agent-io/timeline`);
    assert.equal(timelineRes.status, 200);
    const timeline = (await timelineRes.json()) as {
      items: Array<{ kind: string; content?: string; runId?: string; messageId?: string }>;
    };
    const kinds = new Set(timeline.items.map((item) => item.kind));
    assert.equal(kinds.has("user_message"), true);
    assert.equal(kinds.has("message_routed"), true);
    assert.equal(kinds.has("dispatch_started"), true);
    assert.equal(kinds.has("dispatch_finished"), true);

    const routed = timeline.items.find((item) => item.kind === "message_routed");
    assert.ok(routed);
    assert.equal((routed?.content ?? "").includes("please reply with product summary"), true);

    const dispatch = timeline.items.find((item) => item.kind === "dispatch_finished" && item.runId === runId);
    assert.ok(dispatch);
    assert.equal(dispatch?.messageId, sendPayload.messageId);
  } finally {
    await serverHandle.close();
  }
});
