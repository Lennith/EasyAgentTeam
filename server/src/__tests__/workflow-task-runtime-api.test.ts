import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

test("workflow task runtime API exposes runtime fields, dependency gates, and terminal convergence", async () => {
  const previousInterval = process.env.WORKFLOW_ORCHESTRATOR_INTERVAL_MS;
  process.env.WORKFLOW_ORCHESTRATOR_INTERVAL_MS = "600";
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-task-runtime-"));
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

  async function fetchRuntimeWithRetry(timeoutMs = 8_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const runtime = await fetch(`${baseUrl}/api/workflow-runs/runtime_run_01/task-runtime`);
      if (runtime.status === 200) {
        return runtime;
      }
      if (runtime.status !== 404) {
        assert.equal(runtime.status, 200);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const latest = await fetch(`${baseUrl}/api/workflow-runs/runtime_run_01/task-runtime`);
    assert.equal(latest.status, 200);
    return latest;
  }

  async function readRuntimeStatus() {
    const runtime = await fetchRuntimeWithRetry();
    return (await runtime.json()) as {
      status: string;
      active: boolean;
      counters: { done: number; total: number };
    };
  }

  async function waitForRuntimeStatus(status: string, timeoutMs: number) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const snapshot = await readRuntimeStatus();
      if (snapshot.status === status) {
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const latest = await readRuntimeStatus();
    throw new Error(`timeout waiting for runtime status '${status}', latest='${latest.status}'`);
  }

  async function waitForDoneConverged(timeoutMs: number) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const snapshot = await readRuntimeStatus();
      if (snapshot.counters.done === snapshot.counters.total) {
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const latest = await readRuntimeStatus();
    throw new Error(
      `timeout waiting for done convergence, latest done=${latest.counters.done}, total=${latest.counters.total}`
    );
  }

  try {
    const createTemplate = await fetch(`${baseUrl}/api/workflow-templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "runtime_tpl",
        name: "Runtime Template",
        tasks: [
          { task_id: "task_a", title: "Task A", owner_role: "lead" },
          { task_id: "task_b", title: "Task B", owner_role: "lead", dependencies: ["task_a"] }
        ]
      })
    });
    assert.equal(createTemplate.status, 201);

    const createRun = await fetch(`${baseUrl}/api/workflow-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "runtime_tpl",
        run_id: "runtime_run_01",
        workspace_path: workspaceRoot
      })
    });
    assert.equal(createRun.status, 201);

    const runtimeBeforeStart = await fetchRuntimeWithRetry();
    const beforePayload = (await runtimeBeforeStart.json()) as {
      status: string;
      active: boolean;
      counters: { total: number; planned: number; ready: number };
      tasks: Array<{ taskId: string; state: string; transitionCount: number; transitions: Array<{ toState: string }> }>;
    };
    assert.equal(beforePayload.status, "created");
    assert.equal(beforePayload.active, false);
    assert.equal(beforePayload.counters.total, 2);
    assert.equal(beforePayload.counters.ready, 1);
    assert.equal(beforePayload.counters.planned, 0);
    assert.equal(
      beforePayload.tasks.every((task) => task.transitionCount >= 1),
      true
    );
    assert.equal(
      beforePayload.tasks.every((task) => task.transitions.length >= 1),
      true
    );

    const startRun = await fetch(`${baseUrl}/api/workflow-runs/runtime_run_01/start`, { method: "POST" });
    assert.equal(startRun.status, 200);

    const runtimeAfterStart = await fetch(`${baseUrl}/api/workflow-runs/runtime_run_01/task-runtime`);
    assert.equal(runtimeAfterStart.status, 200);
    const afterPayload = (await runtimeAfterStart.json()) as {
      status: string;
      active: boolean;
      tasks: Array<{ taskId: string; state: string; blockedBy: string[] }>;
    };
    assert.equal(afterPayload.status, "running");
    assert.equal(afterPayload.active, true);
    const taskA = afterPayload.tasks.find((task) => task.taskId === "task_a");
    const taskB = afterPayload.tasks.find((task) => task.taskId === "task_b");
    assert.equal(taskA?.state, "READY");
    assert.equal(taskB?.state, "BLOCKED_DEP");
    assert.deepEqual(taskB?.blockedBy ?? [], ["task_a"]);

    const treeRuntime = await fetch(`${baseUrl}/api/workflow-runs/runtime_run_01/task-tree-runtime`);
    assert.equal(treeRuntime.status, 200);
    const treePayload = (await treeRuntime.json()) as {
      run_id: string;
      nodes: Array<{ taskId: string; runtime: { state: string } | null }>;
      counters: { total: number };
    };
    assert.equal(treePayload.run_id, "runtime_run_01");
    assert.equal(treePayload.nodes.length, 2);
    assert.equal(treePayload.counters.total, 2);
    assert.equal(
      treePayload.nodes.every((node) => node.runtime !== null),
      true
    );

    const reportA = await fetch(`${baseUrl}/api/workflow-runs/runtime_run_01/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "lead",
        results: [{ task_id: "task_a", outcome: "DONE", summary: "task_a done" }]
      })
    });
    assert.equal(reportA.status, 200);

    const reportB = await fetch(`${baseUrl}/api/workflow-runs/runtime_run_01/task-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action_type: "TASK_REPORT",
        from_agent: "lead",
        results: [{ task_id: "task_b", outcome: "DONE", summary: "task_b done" }]
      })
    });
    assert.equal(reportB.status, 200);

    const donePayload = await waitForDoneConverged(8000);
    assert.equal(donePayload.status === "running" || donePayload.status === "finished", true);
    assert.equal(donePayload.counters.done, donePayload.counters.total);

    const finishedPayload = await waitForRuntimeStatus("finished", 8000);
    assert.equal(finishedPayload.active, false);
    assert.equal(finishedPayload.counters.done, finishedPayload.counters.total);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (previousInterval === undefined) {
      delete process.env.WORKFLOW_ORCHESTRATOR_INTERVAL_MS;
    } else {
      process.env.WORKFLOW_ORCHESTRATOR_INTERVAL_MS = previousInterval;
    }
  }
});
