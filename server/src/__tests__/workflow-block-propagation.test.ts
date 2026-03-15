import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

test("workflow dependency propagation moves blocked tasks to READY after dependencies complete", async () => {
  const previousInterval = process.env.WORKFLOW_ORCHESTRATOR_INTERVAL_MS;
  process.env.WORKFLOW_ORCHESTRATOR_INTERVAL_MS = "600";
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-block-propagation-"));
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

  async function taskRuntime() {
    const res = await fetch(`${baseUrl}/api/workflow-runs/block_prop_run_01/task-runtime`);
    assert.equal(res.status, 200);
    return (await res.json()) as {
      status: string;
      active: boolean;
      tasks: Array<{ taskId: string; state: string; blockedBy: string[] }>;
      counters: { done: number };
    };
  }

  async function waitForRunStatus(status: string, timeoutMs: number) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const snapshot = await taskRuntime();
      if (snapshot.status === status) {
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const latest = await taskRuntime();
    throw new Error(`timeout waiting for run status '${status}', latest='${latest.status}'`);
  }

  async function reportDone(taskIds: string[]) {
    const results = taskIds.map((taskId) => ({ task_id: taskId, outcome: "DONE", summary: `${taskId} done` }));
    const res = await fetch(`${baseUrl}/api/workflow-runs/block_prop_run_01/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "manager",
        results
      })
    });
    assert.equal(res.status, 200);
  }

  try {
    const createTemplate = await fetch(`${baseUrl}/api/workflow-templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "block_prop_tpl",
        name: "Block Prop Template",
        tasks: [
          { task_id: "task_lead", title: "Lead", owner_role: "lead" },
          { task_id: "task_b", title: "B", owner_role: "b", dependencies: ["task_lead"] },
          { task_id: "task_c", title: "C", owner_role: "c", dependencies: ["task_lead"] },
          { task_id: "task_d", title: "D", owner_role: "d", dependencies: ["task_lead"] },
          {
            task_id: "task_alignment",
            title: "Alignment",
            owner_role: "lead",
            dependencies: ["task_b", "task_c", "task_d"]
          },
          { task_id: "task_final", title: "Final", owner_role: "lead", dependencies: ["task_alignment"] }
        ]
      })
    });
    assert.equal(createTemplate.status, 201);

    const createRun = await fetch(`${baseUrl}/api/workflow-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "block_prop_tpl",
        run_id: "block_prop_run_01",
        workspace_path: workspaceRoot
      })
    });
    assert.equal(createRun.status, 201);

    const startRun = await fetch(`${baseUrl}/api/workflow-runs/block_prop_run_01/start`, { method: "POST" });
    assert.equal(startRun.status, 200);

    const initial = await taskRuntime();
    const lead = initial.tasks.find((task) => task.taskId === "task_lead");
    const b = initial.tasks.find((task) => task.taskId === "task_b");
    const c = initial.tasks.find((task) => task.taskId === "task_c");
    const d = initial.tasks.find((task) => task.taskId === "task_d");
    assert.equal(lead?.state, "READY");
    assert.equal(b?.state, "BLOCKED_DEP");
    assert.equal(c?.state, "BLOCKED_DEP");
    assert.equal(d?.state, "BLOCKED_DEP");
    assert.deepEqual(b?.blockedBy ?? [], ["task_lead"]);

    await reportDone(["task_lead"]);
    const afterLead = await taskRuntime();
    assert.equal(afterLead.tasks.find((task) => task.taskId === "task_b")?.state, "READY");
    assert.equal(afterLead.tasks.find((task) => task.taskId === "task_c")?.state, "READY");
    assert.equal(afterLead.tasks.find((task) => task.taskId === "task_d")?.state, "READY");
    assert.equal(afterLead.tasks.find((task) => task.taskId === "task_alignment")?.state, "BLOCKED_DEP");

    await reportDone(["task_b", "task_c", "task_d"]);
    const afterBCD = await taskRuntime();
    assert.equal(afterBCD.tasks.find((task) => task.taskId === "task_alignment")?.state, "READY");

    await reportDone(["task_alignment"]);
    const afterAlignment = await taskRuntime();
    assert.equal(afterAlignment.tasks.find((task) => task.taskId === "task_final")?.state, "READY");

    await reportDone(["task_final"]);
    const afterFinalReport = await taskRuntime();
    assert.equal(afterFinalReport.counters.done, 6);
    assert.equal(afterFinalReport.status, "running");
    assert.equal(afterFinalReport.active, true);

    const finalState = await waitForRunStatus("finished", 8000);
    assert.equal(finalState.counters.done, 6);
    assert.equal(finalState.active, false);

    const stopAfterFinished = await fetch(`${baseUrl}/api/workflow-runs/block_prop_run_01/stop`, { method: "POST" });
    assert.equal(stopAfterFinished.status, 200);
    const stopPayload = (await stopAfterFinished.json()) as { runtime: { status: string; active: boolean } };
    assert.equal(stopPayload.runtime.status, "finished");
    assert.equal(stopPayload.runtime.active, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (previousInterval === undefined) {
      delete process.env.WORKFLOW_ORCHESTRATOR_INTERVAL_MS;
    } else {
      process.env.WORKFLOW_ORCHESTRATOR_INTERVAL_MS = previousInterval;
    }
  }
});
