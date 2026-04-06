import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

interface EventRow {
  eventType: string;
  payload: Record<string, unknown>;
}

function parseNdjson(raw: string): EventRow[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EventRow);
}

test("dispatch-message endpoint targets the specified message_id", async () => {
  const originalCodexCommand = process.env.CODEX_CLI_COMMAND;
  process.env.CODEX_CLI_COMMAND = "missing-codex-cli-for-test";
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-dispatch-msg-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "dispatchmsg",
        name: "Dispatch Message",
        workspace_path: tempRoot
      })
    });
    assert.equal(projectRes.status, 201);

    await fetch(`${baseUrl}/api/projects/dispatchmsg/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-pm", role: "PM" })
    });

    const firstSend = await fetch(`${baseUrl}/api/projects/dispatchmsg/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_agent: "manager",
        to: { agent: "PM", session_id: "sess-pm" },
        content: "first message"
      })
    });
    assert.equal(firstSend.status, 201);
    const firstPayload = (await firstSend.json()) as { messageId: string };

    const secondSend = await fetch(`${baseUrl}/api/projects/dispatchmsg/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_agent: "manager",
        to: { agent: "PM", session_id: "sess-pm" },
        content: "second message"
      })
    });
    assert.equal(secondSend.status, 201);

    const dispatchRes = await fetch(`${baseUrl}/api/projects/dispatchmsg/orchestrator/dispatch-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-pm",
        message_id: firstPayload.messageId,
        force: true
      })
    });
    assert.equal(dispatchRes.status, 200);
    const dispatchPayload = (await dispatchRes.json()) as {
      results: Array<{ messageId?: string; outcome: string }>;
    };
    assert.equal(dispatchPayload.results.length, 1);
    assert.equal(dispatchPayload.results[0].messageId, firstPayload.messageId);
    assert.notEqual(dispatchPayload.results[0].outcome, "message_not_found");

    const eventsRes = await fetch(`${baseUrl}/api/projects/dispatchmsg/events`);
    assert.equal(eventsRes.status, 200);
    const events = parseNdjson(await eventsRes.text());
    const startedMessageIds = events
      .filter((item) => item.eventType === "ORCHESTRATOR_DISPATCH_STARTED")
      .flatMap((item) => {
        const payload = item.payload as { messageId?: string | null; messageIds?: unknown };
        const ids = Array.isArray(payload.messageIds)
          ? payload.messageIds.filter((value): value is string => typeof value === "string")
          : [];
        return payload.messageId ? [payload.messageId, ...ids] : ids;
      });
    assert.equal(startedMessageIds.includes(firstPayload.messageId), true);
  } finally {
    await serverHandle.close();
    if (originalCodexCommand === undefined) {
      delete process.env.CODEX_CLI_COMMAND;
    } else {
      process.env.CODEX_CLI_COMMAND = originalCodexCommand;
    }
  }
});

test("dispatch-message endpoint returns message_not_found for unknown message", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-dispatch-msg-miss-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "dispatchmiss",
        name: "Dispatch Missing",
        workspace_path: tempRoot
      })
    });
    assert.equal(projectRes.status, 201);

    const sessionRes = await fetch(`${baseUrl}/api/projects/dispatchmiss/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-pm", role: "PM" })
    });
    assert.equal(sessionRes.status, 201);

    const dispatchRes = await fetch(`${baseUrl}/api/projects/dispatchmiss/orchestrator/dispatch-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "sess-pm",
        message_id: "missing-message-id"
      })
    });
    assert.equal(dispatchRes.status, 200);
    const payload = (await dispatchRes.json()) as {
      results: Array<{ outcome: string }>;
    };
    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0].outcome, "message_not_found");
  } finally {
    await serverHandle.close();
  }
});

test("orchestrator status exposes max concurrent dispatch setting", async () => {
  const originalMaxConcurrent = process.env.ORCHESTRATOR_MAX_CONCURRENT_SESSIONS;
  process.env.ORCHESTRATOR_MAX_CONCURRENT_SESSIONS = "4";
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-orchestrator-status-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const statusRes = await fetch(`${baseUrl}/api/orchestrator/status`);
    assert.equal(statusRes.status, 200);
    const payload = (await statusRes.json()) as {
      maxConcurrentDispatches?: number;
      inFlightDispatchSessions?: number;
    };
    assert.equal(payload.maxConcurrentDispatches, 4);
    assert.equal(typeof payload.inFlightDispatchSessions, "number");
  } finally {
    await serverHandle.close();
    if (originalMaxConcurrent === undefined) {
      delete process.env.ORCHESTRATOR_MAX_CONCURRENT_SESSIONS;
    } else {
      process.env.ORCHESTRATOR_MAX_CONCURRENT_SESSIONS = originalMaxConcurrent;
    }
  }
});
