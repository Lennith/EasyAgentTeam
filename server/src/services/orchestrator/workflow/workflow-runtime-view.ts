import type {
  ReminderMode,
  WorkflowRunRecord,
  WorkflowRunMode,
  WorkflowRunRuntimeSnapshot,
  WorkflowRunRuntimeState,
  WorkflowTaskRuntimeRecord
} from "../../../domain/models.js";
import { normalizeReminderMode } from "../shared/reminder-service.js";
import {
  computeNextWorkflowScheduleTriggerAt,
  parseWorkflowScheduleExpression
} from "./workflow-recurring-schedule.js";

function normalizeWorkflowRunMode(mode: WorkflowRunMode | undefined): WorkflowRunMode {
  if (mode === "loop" || mode === "schedule" || mode === "none") {
    return mode;
  }
  return "none";
}

export function computeWorkflowRuntimeCounters(
  tasks: WorkflowTaskRuntimeRecord[]
): WorkflowRunRuntimeSnapshot["counters"] {
  const counters: WorkflowRunRuntimeSnapshot["counters"] = {
    total: tasks.length,
    planned: 0,
    ready: 0,
    dispatched: 0,
    inProgress: 0,
    mayBeDone: 0,
    blocked: 0,
    done: 0,
    canceled: 0
  };
  for (const task of tasks) {
    if (task.state === "PLANNED") counters.planned += 1;
    else if (task.state === "READY") counters.ready += 1;
    else if (task.state === "DISPATCHED") counters.dispatched += 1;
    else if (task.state === "IN_PROGRESS") counters.inProgress += 1;
    else if (task.state === "MAY_BE_DONE") counters.mayBeDone += 1;
    else if (task.state === "BLOCKED_DEP") counters.blocked += 1;
    else if (task.state === "DONE") counters.done += 1;
    else if (task.state === "CANCELED") counters.canceled += 1;
  }
  return counters;
}

export function buildWorkflowRuntimeSnapshot(
  run: WorkflowRunRecord,
  runtime: WorkflowRunRuntimeState,
  active: boolean
): WorkflowRunRuntimeSnapshot {
  return {
    runId: run.runId,
    status: run.status,
    active,
    updatedAt: runtime.updatedAt,
    counters: computeWorkflowRuntimeCounters(runtime.tasks),
    tasks: runtime.tasks
  };
}

export function buildWorkflowTaskTreeView(
  run: WorkflowRunRecord,
  runtime: WorkflowRunRuntimeState
): {
  roots: string[];
  nodes: Array<Record<string, unknown>>;
  edges: Array<{ from_task_id: string; to_task_id: string; relation: "PARENT_CHILD" | "DEPENDS_ON" }>;
  counters: WorkflowRunRuntimeSnapshot["counters"];
} {
  const runtimeByTask = new Map(runtime.tasks.map((item) => [item.taskId, item]));
  const taskIds = new Set(run.tasks.map((item) => item.taskId));
  const roots = run.tasks
    .filter((task) => {
      const parent = task.parentTaskId?.trim();
      return !parent || !taskIds.has(parent);
    })
    .map((task) => task.taskId);
  const edges: Array<{ from_task_id: string; to_task_id: string; relation: "PARENT_CHILD" | "DEPENDS_ON" }> = [];
  for (const task of run.tasks) {
    const parent = task.parentTaskId?.trim();
    if (parent && taskIds.has(parent)) {
      edges.push({ from_task_id: parent, to_task_id: task.taskId, relation: "PARENT_CHILD" });
    }
    for (const dep of task.dependencies ?? []) {
      if (taskIds.has(dep)) {
        edges.push({ from_task_id: dep, to_task_id: task.taskId, relation: "DEPENDS_ON" });
      }
    }
  }
  return {
    roots,
    nodes: run.tasks.map((task) => ({ ...task, runtime: runtimeByTask.get(task.taskId) ?? null })),
    edges,
    counters: computeWorkflowRuntimeCounters(runtime.tasks)
  };
}

export function buildWorkflowRunSettingsView(run: WorkflowRunRecord): {
  run_id: string;
  mode: WorkflowRunMode;
  loop_enabled: boolean;
  schedule_enabled: boolean;
  schedule_expression?: string;
  is_schedule_seed: boolean;
  origin_run_id?: string;
  last_spawned_run_id?: string;
  spawn_state?: WorkflowRunRecord["spawnState"];
  auto_dispatch_enabled: boolean;
  auto_dispatch_remaining: number;
  auto_dispatch_initial_remaining: number;
  hold_enabled: boolean;
  reminder_mode: ReminderMode;
  recurring_status: {
    occupied: boolean;
    active_run_id?: string;
    next_trigger_at?: string;
    last_triggered_at?: string;
  };
  updated_at: string;
} {
  const normalizedMode = normalizeWorkflowRunMode(run.mode);
  const mode: WorkflowRunMode =
    normalizedMode === "none" ? (run.scheduleEnabled ? "schedule" : run.loopEnabled ? "loop" : "none") : normalizedMode;
  const loopEnabled = run.loopEnabled ?? mode === "loop";
  const scheduleEnabled = run.scheduleEnabled ?? mode === "schedule";
  const isScheduleSeed = run.isScheduleSeed ?? (mode === "schedule" && scheduleEnabled);
  const schedulePattern = parseWorkflowScheduleExpression(run.scheduleExpression ?? undefined);
  const nextTriggerAt =
    mode === "schedule" && scheduleEnabled && isScheduleSeed && schedulePattern
      ? computeNextWorkflowScheduleTriggerAt(schedulePattern)
      : undefined;
  const occupied = Boolean(run.spawnState?.isActive && run.spawnState?.activeRunId);
  const autoDispatchRemaining = Math.max(0, Math.floor(run.autoDispatchRemaining ?? 5));
  const autoDispatchInitialRemaining = Math.max(
    0,
    Math.floor(run.autoDispatchInitialRemaining ?? run.autoDispatchRemaining ?? 5)
  );
  return {
    run_id: run.runId,
    mode,
    loop_enabled: loopEnabled,
    schedule_enabled: scheduleEnabled,
    schedule_expression: run.scheduleExpression,
    is_schedule_seed: isScheduleSeed,
    origin_run_id: run.originRunId,
    last_spawned_run_id: run.lastSpawnedRunId,
    spawn_state: run.spawnState,
    auto_dispatch_enabled: run.autoDispatchEnabled ?? true,
    auto_dispatch_remaining: autoDispatchRemaining,
    auto_dispatch_initial_remaining: autoDispatchInitialRemaining,
    hold_enabled: Boolean(run.holdEnabled),
    reminder_mode: normalizeReminderMode(run.reminderMode),
    recurring_status: {
      occupied,
      active_run_id: occupied ? run.spawnState?.activeRunId : undefined,
      next_trigger_at: nextTriggerAt ?? undefined,
      last_triggered_at: run.spawnState?.lastTriggeredAt ?? run.spawnState?.lastSpawnedAt
    },
    updated_at: run.updatedAt
  };
}

export function buildWorkflowRunStatusView(run: WorkflowRunRecord): {
  runId: string;
  autoDispatchEnabled: boolean;
  autoDispatchRemaining: number;
  holdEnabled: boolean;
  reminderMode: ReminderMode;
} {
  return {
    runId: run.runId,
    autoDispatchEnabled: run.autoDispatchEnabled ?? true,
    autoDispatchRemaining: Math.max(0, Math.floor(run.autoDispatchRemaining ?? 5)),
    holdEnabled: Boolean(run.holdEnabled),
    reminderMode: normalizeReminderMode(run.reminderMode)
  };
}
