import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

test("workflow dispatch prefers deeper runnable task for the same role", async () => {
  const originalCodexCommand = process.env.CODEX_CLI_COMMAND;
  process.env.CODEX_CLI_COMMAND = "missing-codex-cli-for-test";
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-leaf-dispatch-"));
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
        template_id: "wf_leaf_priority_tpl",
        name: "Workflow Leaf Priority Template",
        tasks: [
          { task_id: "wf_root", title: "Root", owner_role: "lead" },
          { task_id: "wf_phase", title: "Phase", owner_role: "lead", parent_task_id: "wf_root" },
          { task_id: "wf_leaf_shallow", title: "Shallow Leaf", owner_role: "lead", parent_task_id: "wf_root" },
          { task_id: "wf_leaf_deep", title: "Deep Leaf", owner_role: "lead", parent_task_id: "wf_phase" }
        ]
      })
    });
    assert.equal(createTemplate.status, 201);

    const createRun = await fetch(`${baseUrl}/api/workflow-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "wf_leaf_priority_tpl",
        run_id: "wf_leaf_priority_run_01",
        workspace_path: workspaceRoot,
        auto_dispatch_enabled: false,
        auto_dispatch_remaining: 0
      })
    });
    assert.equal(createRun.status, 201);

    const startRun = await fetch(`${baseUrl}/api/workflow-runs/wf_leaf_priority_run_01/start`, { method: "POST" });
    assert.equal(startRun.status, 200);

    const createSession = await fetch(`${baseUrl}/api/workflow-runs/wf_leaf_priority_run_01/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "lead",
        session_id: "wf-lead-session-01",
        status: "idle",
        provider_id: "codex"
      })
    });
    assert.equal(createSession.status, 201);

    const dispatch = await fetch(`${baseUrl}/api/workflow-runs/wf_leaf_priority_run_01/orchestrator/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "lead",
        only_idle: true,
        max_dispatches: 1
      })
    });
    assert.equal(dispatch.status, 200);
    const payload = (await dispatch.json()) as {
      results: Array<{ outcome: string; taskId?: string }>;
    };
    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0]?.outcome, "dispatched");
    assert.equal(payload.results[0]?.taskId, "wf_leaf_deep");
  } finally {
    await server.close();
    if (originalCodexCommand === undefined) {
      delete process.env.CODEX_CLI_COMMAND;
    } else {
      process.env.CODEX_CLI_COMMAND = originalCodexCommand;
    }
  }
});
