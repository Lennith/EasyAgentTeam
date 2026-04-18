import type {
  WorkflowRunRecord,
  WorkflowRunRuntimeState,
  WorkflowTaskRuntimeRecord,
  WorkflowTaskState
} from "../../../../domain/models.js";
import { collectOrchestratorUnreadyDependencyIds } from "../dependency-gate.js";

const TERMINAL_STATES = new Set<WorkflowTaskState>(["DONE", "CANCELED"]);
const ACTIVE_STATES = new Set<WorkflowTaskState>(["DISPATCHED", "IN_PROGRESS"]);

export interface WorkflowRuntimeConvergenceResult {
  runtime: WorkflowRunRuntimeState;
  changed: boolean;
}

function cloneRuntimeTask(task: WorkflowTaskRuntimeRecord): WorkflowTaskRuntimeRecord {
  return {
    ...task,
    blockedBy: [...task.blockedBy],
    blockedReasons: task.blockedReasons.map((item) => ({
      ...item,
      dependencyTaskIds: item.dependencyTaskIds ? [...item.dependencyTaskIds] : undefined
    })),
    blockers: task.blockers ? [...task.blockers] : undefined,
    transitions: task.transitions.map((item) => ({ ...item }))
  };
}

function cloneRuntime(runtime: WorkflowRunRuntimeState): WorkflowRunRuntimeState {
  return {
    ...runtime,
    tasks: runtime.tasks.map(cloneRuntimeTask)
  };
}

function createInitialRuntimeTask(taskId: string, seq: number, at: string): WorkflowTaskRuntimeRecord {
  return {
    taskId,
    state: "PLANNED",
    blockedBy: [],
    blockedReasons: [],
    lastTransitionAt: at,
    transitionCount: 1,
    transitions: [{ seq, at, fromState: null, toState: "PLANNED" }]
  };
}

export function isWorkflowTaskTerminalState(state: WorkflowTaskState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isWorkflowTaskActiveState(state: WorkflowTaskState): boolean {
  return ACTIVE_STATES.has(state);
}

export function addWorkflowTaskTransition(
  runtime: WorkflowRunRuntimeState,
  task: WorkflowTaskRuntimeRecord,
  toState: WorkflowTaskState,
  summary?: string,
  now = new Date().toISOString()
): void {
  const fromState = task.state;
  if (fromState === toState) {
    if (summary) {
      task.lastSummary = summary;
    }
    runtime.updatedAt = now;
    return;
  }
  runtime.transitionSeq += 1;
  task.state = toState;
  task.transitionCount += 1;
  task.lastTransitionAt = now;
  if (summary) {
    task.lastSummary = summary;
  }
  task.transitions.push({ seq: runtime.transitionSeq, at: now, fromState, toState, summary });
  runtime.updatedAt = now;
}

export function collectWorkflowUnsatisfiedDependencies(
  run: WorkflowRunRecord,
  tasksById: Map<string, WorkflowTaskRuntimeRecord>,
  taskId: string
): string[] {
  const task = run.tasks.find((item) => item.taskId === taskId);
  if (!task) {
    return [];
  }
  const unresolved: string[] = [];
  for (const dep of task.dependencies ?? []) {
    const depTask = tasksById.get(dep);
    if (!depTask || (depTask.state !== "DONE" && depTask.state !== "CANCELED")) {
      unresolved.push(dep);
    }
  }
  return unresolved;
}

export function resolveWorkflowUnreadyDependencyTaskIds(
  taskDef: WorkflowRunRecord["tasks"][number] | undefined,
  runtimeByTaskId: Map<string, WorkflowTaskRuntimeRecord>,
  stateByTaskId?: Map<string, WorkflowTaskState>
): string[] {
  if (!taskDef) {
    return [];
  }
  return collectOrchestratorUnreadyDependencyIds(taskDef.dependencies ?? [], (dependencyId) => {
    return stateByTaskId?.get(dependencyId) ?? runtimeByTaskId.get(dependencyId)?.state;
  });
}

function reevaluateWorkflowDependencyGate(run: WorkflowRunRecord, runtime: WorkflowRunRuntimeState): void {
  const byId = new Map(runtime.tasks.map((task) => [task.taskId, task]));
  for (const taskDef of run.tasks) {
    const runtimeTask = byId.get(taskDef.taskId);
    if (!runtimeTask) {
      continue;
    }
    if (isWorkflowTaskTerminalState(runtimeTask.state) || isWorkflowTaskActiveState(runtimeTask.state)) {
      continue;
    }
    const unresolved = collectWorkflowUnsatisfiedDependencies(run, byId, taskDef.taskId);
    if (unresolved.length > 0) {
      runtimeTask.blockedBy = unresolved;
      runtimeTask.blockers = unresolved;
      runtimeTask.blockedReasons = [{ code: "DEP_UNSATISFIED", dependencyTaskIds: unresolved }];
      if (runtimeTask.state !== "BLOCKED_DEP") {
        addWorkflowTaskTransition(runtime, runtimeTask, "BLOCKED_DEP");
      }
      continue;
    }
    runtimeTask.blockedBy = [];
    runtimeTask.blockers = undefined;
    runtimeTask.blockedReasons = [];
    if (runtimeTask.state !== "READY") {
      addWorkflowTaskTransition(runtime, runtimeTask, "READY");
    }
  }
}

function recomputeWorkflowParentTaskStates(run: WorkflowRunRecord, runtime: WorkflowRunRuntimeState): void {
  const runtimeById = new Map(runtime.tasks.map((task) => [task.taskId, task]));
  const taskById = new Map(run.tasks.map((task) => [task.taskId, task]));
  const childrenByParent = new Map<string, WorkflowTaskRuntimeRecord[]>();
  for (const taskDef of run.tasks) {
    const parentId = taskDef.parentTaskId?.trim();
    if (!parentId) {
      continue;
    }
    const childRuntime = runtimeById.get(taskDef.taskId);
    if (!childRuntime) {
      continue;
    }
    const current = childrenByParent.get(parentId) ?? [];
    current.push(childRuntime);
    childrenByParent.set(parentId, current);
  }

  const depthCache = new Map<string, number>();
  const visiting = new Set<string>();
  const resolveDepth = (taskId: string): number => {
    const cached = depthCache.get(taskId);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(taskId)) {
      return 0;
    }
    visiting.add(taskId);
    const task = taskById.get(taskId);
    const parent = task?.parentTaskId?.trim();
    const depth = !parent || parent === taskId || !taskById.has(parent) ? 0 : resolveDepth(parent) + 1;
    visiting.delete(taskId);
    depthCache.set(taskId, depth);
    return depth;
  };

  const parentTaskIds = Array.from(childrenByParent.keys()).sort((a, b) => resolveDepth(b) - resolveDepth(a));
  for (const parentTaskId of parentTaskIds) {
    const parentRuntime = runtimeById.get(parentTaskId);
    if (!parentRuntime) {
      continue;
    }
    const children = childrenByParent.get(parentTaskId) ?? [];
    if (children.length === 0) {
      continue;
    }

    const unresolved = collectWorkflowUnsatisfiedDependencies(run, runtimeById, parentTaskId);
    let nextState: WorkflowTaskState;
    if (unresolved.length > 0) {
      parentRuntime.blockedBy = unresolved;
      parentRuntime.blockers = unresolved;
      parentRuntime.blockedReasons = [{ code: "DEP_UNSATISFIED", dependencyTaskIds: unresolved }];
      nextState = "BLOCKED_DEP";
    } else if (children.every((child) => child.state === "DONE" || child.state === "CANCELED")) {
      parentRuntime.blockedBy = [];
      parentRuntime.blockers = undefined;
      parentRuntime.blockedReasons = [];
      nextState = "DONE";
    } else {
      parentRuntime.blockedBy = [];
      parentRuntime.blockers = undefined;
      parentRuntime.blockedReasons = [];
      nextState = "IN_PROGRESS";
    }

    if (parentRuntime.state !== nextState) {
      addWorkflowTaskTransition(runtime, parentRuntime, nextState);
    }
  }
}

export function convergeWorkflowRuntime(
  run: WorkflowRunRecord,
  runtime: WorkflowRunRuntimeState | null | undefined,
  now = new Date().toISOString()
): WorkflowRuntimeConvergenceResult {
  const before = runtime ? JSON.stringify(runtime) : "";
  const base: WorkflowRunRuntimeState = runtime
    ? cloneRuntime(runtime)
    : {
        initializedAt: now,
        updatedAt: now,
        transitionSeq: 0,
        tasks: []
      };

  const existingByTask = new Map(base.tasks.map((item) => [item.taskId, item]));
  const nextTasks: WorkflowTaskRuntimeRecord[] = [];
  for (const taskDef of run.tasks) {
    const existing = existingByTask.get(taskDef.taskId);
    if (existing) {
      nextTasks.push(existing);
      continue;
    }
    base.transitionSeq += 1;
    nextTasks.push(createInitialRuntimeTask(taskDef.taskId, base.transitionSeq, now));
  }
  base.tasks = nextTasks;
  reevaluateWorkflowDependencyGate(run, base);
  recomputeWorkflowParentTaskStates(run, base);
  return {
    runtime: base,
    changed: before !== JSON.stringify(base)
  };
}
