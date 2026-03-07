import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

test("workflow template CRUD and run lifecycle work with workspace_path-only create", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workflow-workspace");
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
        template_id: "travel_plan",
        name: "Travel Plan",
        description: "Collaborative weekend plan",
        default_variables: { city: "Shanghai" },
        tasks: [
          {
            task_id: "task_a",
            title: "Draft weekend {{city}} travel options",
            owner_role: "lead"
          },
          {
            task_id: "task_b",
            title: "Review and refine {{city}} itinerary",
            owner_role: "planner",
            parent_task_id: "task_a",
            dependencies: ["task_a"]
          }
        ]
      })
    });
    assert.equal(createTemplate.status, 201);

    const runCreate = await fetch(`${baseUrl}/api/workflow-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "travel_plan",
        run_id: "travel_run_01",
        workspace_path: workspaceRoot,
        variables: { city: "Shanghai" },
        task_overrides: { task_b: "Negotiate and finalize {{city}} weekend itinerary" }
      })
    });
    assert.equal(runCreate.status, 201);
    const runPayload = (await runCreate.json()) as {
      schemaVersion: string;
      runId: string;
      status: string;
      workspacePath: string;
      tasks: Array<{ taskId: string; resolvedTitle: string }>;
      workspaceBindingMode?: string;
      boundProjectId?: string;
    };
    assert.equal(runPayload.schemaVersion, "2.0");
    assert.equal(runPayload.runId, "travel_run_01");
    assert.equal(runPayload.status, "created");
    assert.equal(path.resolve(runPayload.workspacePath), path.resolve(workspaceRoot));
    assert.equal(Object.prototype.hasOwnProperty.call(runPayload, "workspaceBindingMode"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(runPayload, "boundProjectId"), false);
    const taskA = runPayload.tasks.find((item) => item.taskId === "task_a");
    const taskB = runPayload.tasks.find((item) => item.taskId === "task_b");
    assert.equal(taskA?.resolvedTitle, "Draft weekend Shanghai travel options");
    assert.equal(taskB?.resolvedTitle, "Negotiate and finalize Shanghai weekend itinerary");

    const listRuns = await fetch(`${baseUrl}/api/workflow-runs`);
    assert.equal(listRuns.status, 200);
    const listPayload = (await listRuns.json()) as { total: number };
    assert.equal(listPayload.total, 1);

    const startRun = await fetch(`${baseUrl}/api/workflow-runs/travel_run_01/start`, { method: "POST" });
    assert.equal(startRun.status, 200);
    const startPayload = (await startRun.json()) as { runtime: { status: string; active: boolean } };
    assert.equal(startPayload.runtime.status, "running");
    assert.equal(startPayload.runtime.active, true);

    const stopRun = await fetch(`${baseUrl}/api/workflow-runs/travel_run_01/stop`, { method: "POST" });
    assert.equal(stopRun.status, 200);
    const stopPayload = (await stopRun.json()) as { runtime: { status: string; active: boolean } };
    assert.equal(stopPayload.runtime.status, "stopped");
    assert.equal(stopPayload.runtime.active, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("workflow run create hard-rejects retired binding fields and step-* endpoints are retired", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-hardcut-"));
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
        template_id: "hardcut_tpl",
        name: "Hardcut Template",
        tasks: [{ task_id: "task_a", title: "Task A", owner_role: "lead" }]
      })
    });
    assert.equal(createTemplate.status, 201);

    const withBindingMode = await fetch(`${baseUrl}/api/workflow-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "hardcut_tpl",
        run_id: "hardcut_run_01",
        workspace_path: workspaceRoot,
        workspace_binding_mode: "project"
      })
    });
    assert.equal(withBindingMode.status, 400);

    const withProjectId = await fetch(`${baseUrl}/api/workflow-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "hardcut_tpl",
        run_id: "hardcut_run_02",
        workspace_path: workspaceRoot,
        project_id: "legacy_project"
      })
    });
    assert.equal(withProjectId.status, 400);

    const createRun = await fetch(`${baseUrl}/api/workflow-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "hardcut_tpl",
        run_id: "hardcut_run_03",
        workspace_path: workspaceRoot
      })
    });
    assert.equal(createRun.status, 201);

    const retiredRuntime = await fetch(`${baseUrl}/api/workflow-runs/hardcut_run_03/step-runtime`);
    assert.equal(retiredRuntime.status, 410);
    const retiredRuntimeBody = (await retiredRuntime.json()) as { code?: string };
    assert.equal(retiredRuntimeBody.code, "ENDPOINT_RETIRED");

    const retiredActions = await fetch(`${baseUrl}/api/workflow-runs/hardcut_run_03/step-actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action_type: "STEP_REPORT", results: [] })
    });
    assert.equal(retiredActions.status, 410);
    const retiredActionsBody = (await retiredActions.json()) as { code?: string };
    assert.equal(retiredActionsBody.code, "ENDPOINT_RETIRED");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("workflow orchestrator defaults/settings and task-tree/detail parity endpoints are available", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-orchestrator-defaults-"));
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
        template_id: "wf_defaults_tpl",
        name: "Workflow Defaults Template",
        tasks: [
          { task_id: "wf_task_a", title: "Task A", owner_role: "lead" },
          { task_id: "wf_task_b", title: "Task B", owner_role: "lead", dependencies: ["wf_task_a"] }
        ]
      })
    });
    assert.equal(createTemplate.status, 201);

    const createRun = await fetch(`${baseUrl}/api/workflow-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "wf_defaults_tpl",
        run_id: "wf_defaults_run",
        workspace_path: workspaceRoot
      })
    });
    assert.equal(createRun.status, 201);
    const runPayload = (await createRun.json()) as {
      autoDispatchEnabled?: boolean;
      autoDispatchRemaining?: number;
      holdEnabled?: boolean;
      reminderMode?: string;
    };
    assert.equal(runPayload.autoDispatchEnabled, true);
    assert.equal(runPayload.autoDispatchRemaining, 5);
    assert.equal(runPayload.holdEnabled, false);
    assert.equal(runPayload.reminderMode, "backoff");

    const getSettings = await fetch(`${baseUrl}/api/workflow-runs/wf_defaults_run/orchestrator/settings`);
    assert.equal(getSettings.status, 200);
    const settingsPayload = (await getSettings.json()) as {
      auto_dispatch_enabled: boolean;
      auto_dispatch_remaining: number;
      hold_enabled: boolean;
      reminder_mode: string;
    };
    assert.equal(settingsPayload.auto_dispatch_enabled, true);
    assert.equal(settingsPayload.auto_dispatch_remaining, 5);
    assert.equal(settingsPayload.hold_enabled, false);
    assert.equal(settingsPayload.reminder_mode, "backoff");

    const patchSettings = await fetch(`${baseUrl}/api/workflow-runs/wf_defaults_run/orchestrator/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hold_enabled: true,
        reminder_mode: "fixed_interval",
        auto_dispatch_remaining: 3
      })
    });
    assert.equal(patchSettings.status, 200);
    const patchedPayload = (await patchSettings.json()) as {
      hold_enabled: boolean;
      reminder_mode: string;
      auto_dispatch_remaining: number;
    };
    assert.equal(patchedPayload.hold_enabled, true);
    assert.equal(patchedPayload.reminder_mode, "fixed_interval");
    assert.equal(patchedPayload.auto_dispatch_remaining, 3);

    const startRun = await fetch(`${baseUrl}/api/workflow-runs/wf_defaults_run/start`, { method: "POST" });
    assert.equal(startRun.status, 200);

    const manualDispatchOnHold = await fetch(`${baseUrl}/api/workflow-runs/wf_defaults_run/orchestrator/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "lead", force: true, only_idle: true })
    });
    assert.equal(manualDispatchOnHold.status, 200);
    const dispatchPayload = (await manualDispatchOnHold.json()) as {
      results: Array<{ outcome: string; reason?: string }>;
    };
    assert.equal(dispatchPayload.results[0]?.outcome, "dispatched");

    const treeResp = await fetch(`${baseUrl}/api/workflow-runs/wf_defaults_run/task-tree`);
    assert.equal(treeResp.status, 200);
    const treePayload = (await treeResp.json()) as { nodes: Array<{ task_id: string }>; project_id: string };
    assert.equal(treePayload.project_id, "wf_defaults_run");
    assert.equal(treePayload.nodes.length >= 3, true);

    const detailResp = await fetch(`${baseUrl}/api/workflow-runs/wf_defaults_run/tasks/wf_task_a/detail`);
    assert.equal(detailResp.status, 200);
    const detailPayload = (await detailResp.json()) as { task_id: string; task: { task_id: string } };
    assert.equal(detailPayload.task_id, "wf_task_a");
    assert.equal(detailPayload.task.task_id, "wf_task_a");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("workflow dispatch can auto-select READY task even without inbox messages", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-dispatch-ready-"));
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
        template_id: "wf_dispatch_tpl",
        name: "Workflow Dispatch Template",
        tasks: [{ task_id: "wf_ready_task", title: "Ready Task", owner_role: "lead" }]
      })
    });
    assert.equal(createTemplate.status, 201);

    const createRun = await fetch(`${baseUrl}/api/workflow-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "wf_dispatch_tpl",
        run_id: "wf_dispatch_run",
        workspace_path: workspaceRoot
      })
    });
    assert.equal(createRun.status, 201);

    const startRun = await fetch(`${baseUrl}/api/workflow-runs/wf_dispatch_run/start`, { method: "POST" });
    assert.equal(startRun.status, 200);

    const dispatch = await fetch(`${baseUrl}/api/workflow-runs/wf_dispatch_run/orchestrator/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: "wf_ready_task", force: true, only_idle: true })
    });
    assert.equal(dispatch.status, 200);
    const dispatchPayload = (await dispatch.json()) as {
      results: Array<{ outcome: string; taskId: string | null; dispatchKind?: string | null }>;
    };
    const first = dispatchPayload.results[0];
    assert.equal(first?.outcome, "dispatched");
    assert.equal(first?.taskId, "wf_ready_task");
    assert.equal(first?.dispatchKind, "task");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
