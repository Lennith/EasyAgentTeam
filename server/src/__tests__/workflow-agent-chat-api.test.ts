import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

test("workflow agent-chat SSE endpoint emits stream events and interrupt endpoint is available", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-agent-chat-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const app = createApp({ dataRoot });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start test server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createTemplate = await fetch(`${baseUrl}/api/workflow-templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "agent_chat_tpl",
        name: "Agent Chat Template",
        tasks: [{ task_id: "task_a", title: "Task A", owner_role: "lead" }]
      })
    });
    assert.equal(createTemplate.status, 201);

    const createRun = await fetch(`${baseUrl}/api/workflow-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "agent_chat_tpl",
        run_id: "agent_chat_run_01",
        workspace_path: workspaceRoot
      })
    });
    assert.equal(createRun.status, 201);

    const registerRunSession = await fetch(`${baseUrl}/api/workflow-runs/agent_chat_run_01/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "lead",
        session_id: "wf-orch-session-01",
        status: "running"
      })
    });
    assert.equal(registerRunSession.status, 201);

    const sessionsBeforeResp = await fetch(`${baseUrl}/api/workflow-runs/agent_chat_run_01/sessions`);
    assert.equal(sessionsBeforeResp.status, 200);
    const sessionsBefore = (await sessionsBeforeResp.json()) as { items: Array<{ sessionId: string; status: string }> };
    const beforeOrchestratorSession = sessionsBefore.items.find((item) => item.sessionId === "wf-orch-session-01");
    assert.equal(beforeOrchestratorSession?.status, "running");

    const sseResp = await fetch(`${baseUrl}/api/workflow-runs/agent_chat_run_01/agent-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "lead",
        prompt: "hello",
        sessionId: "wfchat-session-01"
      })
    });
    assert.equal(sseResp.status, 200);
    const sseText = await sseResp.text();
    assert.equal(sseText.includes("event: "), true);
    assert.equal(sseText.includes("event: error"), true);

    const sessionsAfterResp = await fetch(`${baseUrl}/api/workflow-runs/agent_chat_run_01/sessions`);
    assert.equal(sessionsAfterResp.status, 200);
    const sessionsAfter = (await sessionsAfterResp.json()) as { items: Array<{ sessionId: string; status: string }> };
    assert.equal(
      sessionsAfter.items.some((item) => item.sessionId === "wfchat-session-01"),
      false
    );
    const afterOrchestratorSession = sessionsAfter.items.find((item) => item.sessionId === "wf-orch-session-01");
    assert.equal(afterOrchestratorSession?.status, "running");

    const interruptResp = await fetch(
      `${baseUrl}/api/workflow-runs/agent_chat_run_01/agent-chat/wfchat-session-01/interrupt`,
      { method: "POST" }
    );
    assert.equal(interruptResp.status, 200);
    const interruptPayload = (await interruptResp.json()) as { success?: boolean; cancelled?: boolean };
    assert.equal(interruptPayload.success, true);
    assert.equal(typeof interruptPayload.cancelled, "boolean");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
