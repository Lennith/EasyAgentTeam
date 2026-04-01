import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

test("workflow dependency propagation moves blocked tasks to READY after dependencies complete", async () => {
  const previousInterval = process.env.WORKFLOW_ORCHESTRATOR_INTERVAL_MS;
  process.env.WORKFLOW_ORCHESTRATOR_INTERVAL_MS = "300";
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-block-propagation-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

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

  async function waitForTaskStateIn(taskId: string, expectedStates: string[], timeoutMs: number) {
    const expected = new Set(expectedStates);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const snapshot = await taskRuntime();
      const task = snapshot.tasks.find((item) => item.taskId === taskId);
      if (task && expected.has(task.state)) {
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const latest = await taskRuntime();
    const latestState = latest.tasks.find((item) => item.taskId === taskId)?.state ?? "missing";
    throw new Error(
      `timeout waiting for task '${taskId}' state in [${expectedStates.join(", ")}], latest='${latestState}'`
    );
  }

  async function waitForTaskDoneEligible(taskIds: string[], timeoutMs: number) {
    const reportableStates = new Set(["PLANNED", "READY", "DISPATCHED", "IN_PROGRESS", "MAY_BE_DONE"]);
    const terminalStates = new Set(["DONE", "CANCELED"]);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const snapshot = await taskRuntime();
      const byTaskId = new Map(snapshot.tasks.map((item) => [item.taskId, item]));
      const pending = taskIds
        .map((taskId) => byTaskId.get(taskId))
        .filter((item): item is { taskId: string; state: string; blockedBy: string[] } => Boolean(item));
      const allEligible = pending.every((task) => terminalStates.has(task.state) || reportableStates.has(task.state));
      if (allEligible) {
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const latest = await taskRuntime();
    const states = taskIds.map((taskId) => ({
      taskId,
      state: latest.tasks.find((item) => item.taskId === taskId)?.state ?? "missing"
    }));
    throw new Error(`timeout waiting task done eligibility: ${JSON.stringify(states)}`);
  }

  async function waitForTasksTerminal(taskIds: string[], timeoutMs: number) {
    const terminalStates = new Set(["DONE", "CANCELED"]);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const snapshot = await taskRuntime();
      const allTerminal = taskIds.every((taskId) => {
        const state = snapshot.tasks.find((item) => item.taskId === taskId)?.state;
        return state ? terminalStates.has(state) : false;
      });
      if (allTerminal) {
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const latest = await taskRuntime();
    const states = taskIds.map((taskId) => ({
      taskId,
      state: latest.tasks.find((item) => item.taskId === taskId)?.state ?? "missing"
    }));
    throw new Error(`timeout waiting task terminal states: ${JSON.stringify(states)}`);
  }

  async function reportDone(taskIds: string[]) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const snapshot = await waitForTaskDoneEligible(taskIds, 6000);
      const pendingTaskIds = taskIds.filter((taskId) => {
        const state = snapshot.tasks.find((item) => item.taskId === taskId)?.state;
        return state !== "DONE" && state !== "CANCELED";
      });
      if (pendingTaskIds.length === 0) {
        return;
      }

      const sendReport = async () =>
        await fetch(`${baseUrl}/api/workflow-runs/block_prop_run_01/task-actions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action_type: "TASK_REPORT",
            from_agent: "manager",
            results: pendingTaskIds.map((taskId) => ({
              task_id: taskId,
              outcome: "DONE",
              summary: `${taskId} done`
            }))
          })
        });

      const response = await sendReport();
      if (response.status !== 200) {
        let payload: Record<string, unknown> | null = null;
        try {
          payload = (await response.json()) as Record<string, unknown>;
        } catch {
          payload = null;
        }
        const payloadError =
          payload && typeof payload.error === "object" && payload.error !== null
            ? (payload.error as Record<string, unknown>)
            : null;
        const errorCode =
          (typeof payload?.error_code === "string" ? payload.error_code : undefined) ??
          (typeof payloadError?.code === "string" ? payloadError.code : undefined);
        if (response.status === 409 && errorCode === "TASK_DEPENDENCY_NOT_READY") {
          await new Promise((resolve) => setTimeout(resolve, 300));
          continue;
        }
        const body = payload ? JSON.stringify(payload) : await response.text();
        assert.equal(response.status, 200, `report failed: status=${response.status}, body=${body}`);
      }

      try {
        await waitForTasksTerminal(pendingTaskIds, 6000);
        return;
      } catch {
        if (attempt >= 3) {
          throw new Error(`tasks not terminal after retries: ${pendingTaskIds.join(", ")}`);
        }
      }
    }
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
    const afterLead = await waitForTaskStateIn("task_b", ["READY", "DISPATCHED", "IN_PROGRESS", "DONE"], 8000);
    assert.notEqual(afterLead.tasks.find((task) => task.taskId === "task_b")?.state, "BLOCKED_DEP");
    assert.notEqual(afterLead.tasks.find((task) => task.taskId === "task_c")?.state, "BLOCKED_DEP");
    assert.notEqual(afterLead.tasks.find((task) => task.taskId === "task_d")?.state, "BLOCKED_DEP");
    assert.equal(afterLead.tasks.find((task) => task.taskId === "task_alignment")?.state, "BLOCKED_DEP");

    await reportDone(["task_b", "task_c", "task_d"]);
    const afterBCD = await waitForTaskStateIn("task_alignment", ["READY", "DISPATCHED", "IN_PROGRESS", "DONE"], 8000);
    assert.notEqual(afterBCD.tasks.find((task) => task.taskId === "task_alignment")?.state, "BLOCKED_DEP");

    await reportDone(["task_alignment"]);
    const afterAlignment = await waitForTaskStateIn("task_final", ["READY", "DISPATCHED", "IN_PROGRESS", "DONE"], 8000);
    assert.notEqual(afterAlignment.tasks.find((task) => task.taskId === "task_final")?.state, "BLOCKED_DEP");

    await reportDone(["task_final"]);
    const finalState = await waitForRunStatus("finished", 45000);
    assert.equal(finalState.tasks.find((task) => task.taskId === "task_final")?.state, "DONE");
    assert.equal(finalState.counters.done, 6);
    assert.equal(finalState.active, false);

    const stopAfterFinished = await fetch(`${baseUrl}/api/workflow-runs/block_prop_run_01/stop`, { method: "POST" });
    assert.equal(stopAfterFinished.status, 200);
    const stopPayload = (await stopAfterFinished.json()) as { runtime: { status: string; active: boolean } };
    assert.equal(stopPayload.runtime.status, "finished");
    assert.equal(stopPayload.runtime.active, false);
  } finally {
    await serverHandle.close();
    if (previousInterval === undefined) {
      delete process.env.WORKFLOW_ORCHESTRATOR_INTERVAL_MS;
    } else {
      process.env.WORKFLOW_ORCHESTRATOR_INTERVAL_MS = previousInterval;
    }
  }
});
