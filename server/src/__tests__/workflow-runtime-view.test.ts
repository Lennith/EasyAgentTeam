import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkflowRunSettingsView,
  buildWorkflowRunStatusView,
  buildWorkflowRuntimeSnapshot,
  buildWorkflowTaskTreeView
} from "../services/orchestrator/workflow/workflow-runtime-view.js";

test("workflow runtime view builds snapshot and counters deterministically", () => {
  const snapshot = buildWorkflowRuntimeSnapshot(
    {
      runId: "run-1",
      status: "running"
    } as any,
    {
      updatedAt: "2026-03-28T12:00:00.000Z",
      tasks: [
        { taskId: "task-a", state: "READY" },
        { taskId: "task-b", state: "BLOCKED_DEP" },
        { taskId: "task-c", state: "DONE" }
      ]
    } as any,
    true
  );

  assert.deepEqual(snapshot, {
    runId: "run-1",
    status: "running",
    active: true,
    updatedAt: "2026-03-28T12:00:00.000Z",
    counters: {
      total: 3,
      planned: 0,
      ready: 1,
      dispatched: 0,
      inProgress: 0,
      blocked: 1,
      done: 1,
      canceled: 0
    },
    tasks: [
      { taskId: "task-a", state: "READY" },
      { taskId: "task-b", state: "BLOCKED_DEP" },
      { taskId: "task-c", state: "DONE" }
    ]
  });
});

test("workflow runtime view builds task tree edges and settings summaries", () => {
  const run = {
    runId: "run-1",
    status: "running",
    updatedAt: "2026-03-28T12:00:00.000Z",
    autoDispatchEnabled: true,
    autoDispatchRemaining: 4.8,
    autoDispatchInitialRemaining: 6.8,
    holdEnabled: false,
    reminderMode: undefined,
    tasks: [
      { taskId: "root", title: "Root", ownerRole: "manager" },
      { taskId: "child", title: "Child", ownerRole: "dev", parentTaskId: "root", dependencies: ["dep"] },
      { taskId: "dep", title: "Dependency", ownerRole: "qa" }
    ]
  } as any;
  const runtime = {
    tasks: [
      { taskId: "root", state: "IN_PROGRESS" },
      { taskId: "child", state: "READY" },
      { taskId: "dep", state: "DONE" }
    ]
  } as any;

  const tree = buildWorkflowTaskTreeView(run, runtime);

  assert.deepEqual(tree.roots, ["root", "dep"]);
  assert.deepEqual(tree.edges, [
    { from_task_id: "root", to_task_id: "child", relation: "PARENT_CHILD" },
    { from_task_id: "dep", to_task_id: "child", relation: "DEPENDS_ON" }
  ]);
  assert.equal((tree.nodes[1] as any).runtime?.taskId, "child");
  assert.deepEqual(buildWorkflowRunSettingsView(run), {
    run_id: "run-1",
    mode: "none",
    loop_enabled: false,
    schedule_enabled: false,
    schedule_expression: undefined,
    is_schedule_seed: false,
    origin_run_id: undefined,
    last_spawned_run_id: undefined,
    spawn_state: undefined,
    auto_dispatch_enabled: true,
    auto_dispatch_remaining: 4,
    auto_dispatch_initial_remaining: 6,
    hold_enabled: false,
    reminder_mode: "backoff",
    recurring_status: {
      occupied: false,
      active_run_id: undefined,
      next_trigger_at: undefined,
      last_triggered_at: undefined
    },
    updated_at: "2026-03-28T12:00:00.000Z"
  });
  assert.deepEqual(buildWorkflowRunStatusView(run), {
    runId: "run-1",
    autoDispatchEnabled: true,
    autoDispatchRemaining: 4,
    holdEnabled: false,
    reminderMode: "backoff"
  });
});
