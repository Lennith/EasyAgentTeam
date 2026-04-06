import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowRunRecord, WorkflowRunRuntimeState, WorkflowRunTaskRecord } from "../domain/models.js";
import { evaluateWorkflowAutoFinishWindow } from "../services/orchestrator/shared/runtime/workflow-auto-finish-window.js";
import {
  addWorkflowTaskTransition,
  convergeWorkflowRuntime,
  resolveWorkflowUnreadyDependencyTaskIds
} from "../services/orchestrator/shared/runtime/workflow-runtime-kernel.js";

function createRun(
  tasks: Array<
    Omit<WorkflowRunTaskRecord, "resolvedTitle"> & {
      resolvedTitle?: string;
    }
  >
): WorkflowRunRecord {
  return {
    schemaVersion: "2.0",
    runId: "run-kernel",
    templateId: "tpl",
    name: "Kernel Run",
    workspacePath: "C:\\temp\\workspace",
    tasks: tasks.map((task) => ({
      ...task,
      resolvedTitle: task.resolvedTitle ?? task.title
    })),
    createdAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:00:00.000Z",
    status: "created"
  };
}

function createRuntime(
  taskStates: Record<string, WorkflowRunRuntimeState["tasks"][number]["state"]>
): WorkflowRunRuntimeState {
  const tasks = Object.entries(taskStates).map(([taskId, state], index) => ({
    taskId,
    state,
    blockedBy: [],
    blockedReasons: [],
    lastTransitionAt: `2026-03-28T00:00:0${index}.000Z`,
    transitionCount: 1,
    transitions: [
      {
        seq: index + 1,
        at: `2026-03-28T00:00:0${index}.000Z`,
        fromState: null,
        toState: state
      }
    ]
  }));
  return {
    initializedAt: "2026-03-28T00:00:00.000Z",
    updatedAt: "2026-03-28T00:00:00.000Z",
    transitionSeq: tasks.length,
    tasks
  };
}

test("workflow runtime convergence moves blocked task to READY when dependencies complete", () => {
  const run = createRun([
    { taskId: "task_a", title: "A", ownerRole: "lead" },
    { taskId: "task_b", title: "B", ownerRole: "lead", dependencies: ["task_a"] }
  ]);
  const runtime = createRuntime({
    task_a: "DONE",
    task_b: "BLOCKED_DEP"
  });

  const { runtime: converged } = convergeWorkflowRuntime(run, runtime, "2026-03-28T00:00:10.000Z");
  const taskB = converged.tasks.find((item) => item.taskId === "task_b");

  assert.equal(taskB?.state, "READY");
  assert.deepEqual(taskB?.blockedBy ?? [], []);
});

test("workflow runtime convergence unlocks multi-dependency tasks in the same snapshot", () => {
  const run = createRun([
    { taskId: "task_b", title: "B", ownerRole: "b" },
    { taskId: "task_c", title: "C", ownerRole: "c" },
    { taskId: "task_d", title: "D", ownerRole: "d" },
    { taskId: "task_alignment", title: "Alignment", ownerRole: "lead", dependencies: ["task_b", "task_c", "task_d"] }
  ]);
  const runtime = createRuntime({
    task_b: "DONE",
    task_c: "DONE",
    task_d: "DONE",
    task_alignment: "BLOCKED_DEP"
  });

  const { runtime: converged } = convergeWorkflowRuntime(run, runtime, "2026-03-28T00:00:10.000Z");
  assert.equal(converged.tasks.find((item) => item.taskId === "task_alignment")?.state, "READY");
});

test("workflow runtime convergence recomputes parent states and does not reopen terminal leaf tasks", () => {
  const run = createRun([
    { taskId: "parent", title: "Parent", ownerRole: "lead" },
    { taskId: "child_a", title: "Child A", ownerRole: "lead", parentTaskId: "parent" },
    { taskId: "child_b", title: "Child B", ownerRole: "lead", parentTaskId: "parent" },
    { taskId: "done_leaf", title: "Done Leaf", ownerRole: "lead", dependencies: ["canceled_dep"] },
    { taskId: "canceled_dep", title: "Canceled Dep", ownerRole: "lead" }
  ]);
  const runtime = createRuntime({
    parent: "READY",
    child_a: "DONE",
    child_b: "IN_PROGRESS",
    done_leaf: "DONE",
    canceled_dep: "CANCELED"
  });

  const { runtime: first } = convergeWorkflowRuntime(run, runtime, "2026-03-28T00:00:10.000Z");
  assert.equal(first.tasks.find((item) => item.taskId === "parent")?.state, "IN_PROGRESS");
  assert.equal(first.tasks.find((item) => item.taskId === "done_leaf")?.state, "DONE");

  const second = createRuntime({
    parent: "IN_PROGRESS",
    child_a: "DONE",
    child_b: "DONE",
    done_leaf: "DONE",
    canceled_dep: "CANCELED"
  });
  const { runtime: finished } = convergeWorkflowRuntime(run, second, "2026-03-28T00:00:20.000Z");
  assert.equal(finished.tasks.find((item) => item.taskId === "parent")?.state, "DONE");

  const runtimeByTaskId = new Map(finished.tasks.map((item) => [item.taskId, item]));
  const unresolved = resolveWorkflowUnreadyDependencyTaskIds(
    run.tasks.find((item) => item.taskId === "done_leaf"),
    runtimeByTaskId
  );
  assert.deepEqual(unresolved, []);
});

test("workflow auto finish window is deterministic for tick, reset, and finalize cases", () => {
  assert.deepEqual(
    evaluateWorkflowAutoFinishWindow({
      previousStableTicks: 0,
      unfinishedTaskCount: 0,
      runningSessionCount: 0,
      requiredStableTicks: 2
    }),
    {
      eligible: true,
      stableTicks: 1,
      previousStableTicks: 0,
      reset: false,
      shouldFinalize: false
    }
  );

  assert.deepEqual(
    evaluateWorkflowAutoFinishWindow({
      previousStableTicks: 1,
      unfinishedTaskCount: 0,
      runningSessionCount: 0,
      requiredStableTicks: 2
    }),
    {
      eligible: true,
      stableTicks: 2,
      previousStableTicks: 1,
      reset: false,
      shouldFinalize: true
    }
  );

  assert.deepEqual(
    evaluateWorkflowAutoFinishWindow({
      previousStableTicks: 1,
      unfinishedTaskCount: 1,
      runningSessionCount: 0,
      requiredStableTicks: 2
    }),
    {
      eligible: false,
      stableTicks: 0,
      previousStableTicks: 1,
      reset: true,
      shouldFinalize: false
    }
  );
});

test("addWorkflowTaskTransition preserves state when target is unchanged and updates summary", () => {
  const runtime = createRuntime({ task_a: "READY" });
  const task = runtime.tasks[0];
  addWorkflowTaskTransition(runtime, task, "READY", "same-state-summary", "2026-03-28T00:00:10.000Z");
  assert.equal(task.state, "READY");
  assert.equal(task.transitionCount, 1);
  assert.equal(task.lastSummary, "same-state-summary");
});
