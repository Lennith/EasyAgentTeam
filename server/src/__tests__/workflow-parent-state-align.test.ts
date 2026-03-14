import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

test("workflow parent task state follows child completion progress", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-parent-state-align-"));
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
        template_id: "wf_parent_align_tpl",
        name: "Workflow Parent Align Template",
        tasks: [
          {
            task_id: "phase_exec",
            title: "Execute Android implementation and integration contracts",
            owner_role: "lead"
          },
          { task_id: "dev_a", title: "Implementation A", owner_role: "lead", parent_task_id: "phase_exec" },
          {
            task_id: "dev_b",
            title: "Implementation B",
            owner_role: "lead",
            parent_task_id: "phase_exec",
            dependencies: ["dev_a"]
          }
        ]
      })
    });
    assert.equal(createTemplate.status, 201);

    const createRun = await fetch(`${baseUrl}/api/workflow-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "wf_parent_align_tpl",
        run_id: "wf_parent_align_run_01",
        workspace_path: workspaceRoot
      })
    });
    assert.equal(createRun.status, 201);

    const startRun = await fetch(`${baseUrl}/api/workflow-runs/wf_parent_align_run_01/start`, { method: "POST" });
    assert.equal(startRun.status, 200);

    const markPhaseDoneEarly = await fetch(`${baseUrl}/api/workflow-runs/wf_parent_align_run_01/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "lead",
        from_session_id: "session-lead-01",
        results: [{ task_id: "phase_exec", outcome: "DONE", summary: "phase reported done early" }]
      })
    });
    assert.equal(markPhaseDoneEarly.status, 200);

    const runtimeAfterPhaseDone = await fetch(`${baseUrl}/api/workflow-runs/wf_parent_align_run_01/task-runtime`);
    assert.equal(runtimeAfterPhaseDone.status, 200);
    const runtimeAfterPhaseDonePayload = (await runtimeAfterPhaseDone.json()) as {
      tasks: Array<{ taskId: string; state: string }>;
    };
    const phaseAfterEarlyDone = runtimeAfterPhaseDonePayload.tasks.find((item) => item.taskId === "phase_exec");
    assert.ok(phaseAfterEarlyDone);
    assert.equal(phaseAfterEarlyDone.state, "IN_PROGRESS");

    const completeSubTasks = await fetch(`${baseUrl}/api/workflow-runs/wf_parent_align_run_01/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "lead",
        from_session_id: "session-lead-01",
        results: [
          { task_id: "dev_a", outcome: "DONE", summary: "subtask a done" },
          { task_id: "dev_b", outcome: "DONE", summary: "subtask b done" }
        ]
      })
    });
    assert.equal(completeSubTasks.status, 200);

    const runtimeAfterChildrenDone = await fetch(`${baseUrl}/api/workflow-runs/wf_parent_align_run_01/task-runtime`);
    assert.equal(runtimeAfterChildrenDone.status, 200);
    const runtimeAfterChildrenDonePayload = (await runtimeAfterChildrenDone.json()) as {
      tasks: Array<{ taskId: string; state: string }>;
    };
    const phaseAfterChildrenDone = runtimeAfterChildrenDonePayload.tasks.find((item) => item.taskId === "phase_exec");
    assert.ok(phaseAfterChildrenDone);
    assert.equal(phaseAfterChildrenDone.state, "DONE");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
