import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

test("workflow-native sessions/messages/timeline work end-to-end", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-chat-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;

  try {
    const createTemplate = await fetch(`${baseUrl}/api/workflow-templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "chat_tpl",
        name: "Chat Template",
        route_table: {
          manager: ["lead", "architect"],
          lead: ["architect"],
          architect: ["lead"]
        },
        tasks: [
          { task_id: "task_a", title: "Task A", owner_role: "lead" },
          { task_id: "task_b", title: "Task B", owner_role: "architect", dependencies: ["task_a"] }
        ]
      })
    });
    assert.equal(createTemplate.status, 201);

    const createRun = await fetch(`${baseUrl}/api/workflow-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "chat_tpl",
        run_id: "chat_run_01",
        workspace_path: workspaceRoot
      })
    });
    assert.equal(createRun.status, 201);

    const startRun = await fetch(`${baseUrl}/api/workflow-runs/chat_run_01/start`, { method: "POST" });
    assert.equal(startRun.status, 200);

    const registerLead = await fetch(`${baseUrl}/api/workflow-runs/chat_run_01/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "lead", session_id: "session-lead-01" })
    });
    assert.equal(registerLead.status, 201);

    const registerArchitect = await fetch(`${baseUrl}/api/workflow-runs/chat_run_01/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "architect", session_id: "session-architect-01" })
    });
    assert.equal(registerArchitect.status, 201);

    const sessionsResp = await fetch(`${baseUrl}/api/workflow-runs/chat_run_01/sessions`);
    assert.equal(sessionsResp.status, 200);
    const sessionsPayload = (await sessionsResp.json()) as { items: Array<{ role: string; sessionId: string }> };
    assert.equal(sessionsPayload.items.length >= 2, true);
    assert.equal(
      sessionsPayload.items.some((item) => item.role === "lead"),
      true
    );
    assert.equal(
      sessionsPayload.items.some((item) => item.role === "architect"),
      true
    );

    const sendMessage = await fetch(`${baseUrl}/api/workflow-runs/chat_run_01/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_agent: "manager",
        from_session_id: "manager-system",
        to_role: "lead",
        task_id: "task_a",
        content: "Please start drafting task_a.",
        request_id: "req-msg-01"
      })
    });
    assert.equal(sendMessage.status, 200);
    const sendPayload = (await sendMessage.json()) as { messageId?: string; resolvedSessionId?: string };
    assert.equal(typeof sendPayload.messageId, "string");
    assert.equal(typeof sendPayload.resolvedSessionId, "string");

    const report = await fetch(`${baseUrl}/api/workflow-runs/chat_run_01/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "lead",
        from_session_id: "session-lead-01",
        task_id: "task_a",
        results: [{ task_id: "task_a", outcome: "DONE", summary: "task_a done" }]
      })
    });
    assert.equal(report.status, 200);

    const timelineResp = await fetch(`${baseUrl}/api/workflow-runs/chat_run_01/agent-io/timeline?limit=200`);
    assert.equal(timelineResp.status, 200);
    const timelinePayload = (await timelineResp.json()) as {
      items: Array<{ kind?: string }>;
      total: number;
    };
    assert.equal(timelinePayload.total >= 3, true);
    assert.equal(
      timelinePayload.items.some((item) => item.kind === "user_message"),
      true
    );
    assert.equal(
      timelinePayload.items.some((item) => item.kind === "message_routed"),
      true
    );
    assert.equal(
      timelinePayload.items.some((item) => item.kind === "task_report"),
      true
    );
  } finally {
    await server.close();
  }
});
