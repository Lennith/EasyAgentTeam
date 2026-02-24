import type {
  NextActionInput,
  ProjectPaths,
  TaskKind,
  TaskRecord,
  TaskReport,
  TaskState,
  TaskboardState
} from "../domain/models.js";
import { readJsonFile, writeJsonFile } from "./file-utils.js";

const VALID_TASK_STATES = new Set<TaskState>([
  "PLANNED",
  "READY",
  "DISPATCHED",
  "IN_PROGRESS",
  "BLOCKED_DEP",
  "MAY_BE_DONE",
  "DONE",
  "CANCELED"
]);

const TERMINAL_TASK_STATES = new Set<TaskState>(["DONE", "CANCELED"]);
const ACTIVE_TASK_STATES = new Set<TaskState>(["DISPATCHED", "IN_PROGRESS"]);
const PRESERVED_STATES = new Set<TaskState>(["MAY_BE_DONE"]);

export class TaskboardStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_TASK_ID"
      | "INVALID_TASK_STATE"
      | "TASK_EXISTS"
      | "TASK_NOT_FOUND"
      | "INVALID_OWNER_ROLE"
      | "TASK_PARENT_REQUIRED"
      | "TASK_PARENT_NOT_FOUND"
      | "TASK_ROOT_NOT_FOUND"
      | "TASK_DEPENDENCY_NOT_FOUND"
      | "TASK_DEPENDENCY_CYCLE"
      | "TASK_DEPENDENCY_CROSS_ROOT"
      | "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN",
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export interface TaskCreateInput {
  taskId: string;
  taskKind?: TaskKind;
  parentTaskId?: string;
  rootTaskId?: string;
  title: string;
  creatorRole?: string;
  creatorSessionId?: string;
  ownerRole: string;
  ownerSession?: string;
  state?: TaskState;
  priority?: number;
  writeSet?: string[];
  dependencies?: string[];
  acceptance?: string[];
  artifacts?: string[];
  alert?: string;
}

export interface TaskPatchInput {
  taskKind?: TaskKind;
  parentTaskId?: string;
  rootTaskId?: string;
  title?: string;
  creatorRole?: string;
  creatorSessionId?: string;
  ownerRole?: string;
  ownerSession?: string | null;
  state?: TaskState;
  priority?: number;
  writeSet?: string[];
  dependencies?: string[];
  acceptance?: string[];
  artifacts?: string[];
  alert?: string | null;
  grantedAt?: string | null;
  closedAt?: string | null;
  closeReportId?: string | null;
  lastSummary?: string;
}

interface UpsertOptions {
  allowCreate: boolean;
}

function defaultTaskboard(projectId: string): TaskboardState {
  return {
    schemaVersion: "1.0",
    projectId,
    updatedAt: new Date().toISOString(),
    tasks: []
  };
}

function normalizeTaskId(taskId: string): string {
  const normalized = taskId.trim();
  if (!normalized || !/^[a-zA-Z0-9._:-]+$/.test(normalized)) {
    throw new TaskboardStoreError("task_id is invalid", "INVALID_TASK_ID");
  }
  return normalized;
}

function normalizeOwnerRole(ownerRole: string): string {
  const normalized = ownerRole.trim();
  if (!normalized) {
    throw new TaskboardStoreError("owner_role is required", "INVALID_OWNER_ROLE");
  }
  return normalized;
}

function normalizeStringArray(input: string[] | undefined): string[] {
  return (input ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
}

function normalizeTaskState(state: TaskState | undefined): TaskState {
  const normalized = (state ?? "PLANNED") as TaskState;
  if (!VALID_TASK_STATES.has(normalized)) {
    throw new TaskboardStoreError(`Invalid task state: ${state}`, "INVALID_TASK_STATE");
  }
  return normalized;
}

function normalizeTaskKind(kind: TaskKind | undefined): TaskKind {
  if (kind === "PROJECT_ROOT" || kind === "USER_ROOT" || kind === "EXECUTION") {
    return kind;
  }
  return "EXECUTION";
}

function normalizePriority(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-100, Math.min(100, Math.floor(value)));
}

function taskById(tasks: TaskRecord[]): Map<string, TaskRecord> {
  return new Map(tasks.map((task) => [task.taskId, task]));
}

function buildChildrenMap(tasks: TaskRecord[]): Map<string, TaskRecord[]> {
  const map = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    if (!map.has(task.parentTaskId)) {
      map.set(task.parentTaskId, []);
    }
    map.get(task.parentTaskId)!.push(task);
  }
  return map;
}

function assertParentAndRoot(
  state: TaskboardState,
  input: TaskCreateInput,
  taskId: string,
  taskKind: TaskKind
): { parentTaskId: string; rootTaskId: string } {
  const byId = taskById(state.tasks);
  if (taskKind === "PROJECT_ROOT") {
    return { parentTaskId: taskId, rootTaskId: taskId };
  }
  const parentTaskId = normalizeTaskId(input.parentTaskId ?? "");
  const parent = byId.get(parentTaskId);
  if (!parent) {
    throw new TaskboardStoreError(`parent task '${parentTaskId}' not found`, "TASK_PARENT_NOT_FOUND");
  }
  if (taskKind === "USER_ROOT") {
    return { parentTaskId, rootTaskId: taskId };
  }
  const rootTaskId = input.rootTaskId?.trim() ? normalizeTaskId(input.rootTaskId) : parent.rootTaskId;
  const root = byId.get(rootTaskId);
  if (!root && rootTaskId !== taskId) {
    throw new TaskboardStoreError(`root task '${rootTaskId}' not found`, "TASK_ROOT_NOT_FOUND");
  }
  if (parent.rootTaskId !== rootTaskId) {
    throw new TaskboardStoreError("parent and root are inconsistent", "TASK_DEPENDENCY_CROSS_ROOT");
  }
  return { parentTaskId, rootTaskId };
}

function assertDependenciesValid(
  state: TaskboardState,
  taskId: string,
  parentTaskId: string,
  rootTaskId: string,
  dependencies: string[]
): void {
  if (dependencies.length === 0) {
    return;
  }
  const byId = taskById(state.tasks);
  for (const depId of dependencies) {
    const dep = byId.get(depId);
    if (!dep) {
      throw new TaskboardStoreError(`dependency '${depId}' not found`, "TASK_DEPENDENCY_NOT_FOUND");
    }
    if (dep.rootTaskId !== rootTaskId) {
      throw new TaskboardStoreError(
        `dependency '${depId}' crosses root boundary`,
        "TASK_DEPENDENCY_CROSS_ROOT"
      );
    }
  }

  const ancestorTaskIds: string[] = [];
  const ancestorVisited = new Set<string>([taskId]);
  let currentAncestorId = parentTaskId;
  while (currentAncestorId && !ancestorVisited.has(currentAncestorId)) {
    ancestorTaskIds.push(currentAncestorId);
    ancestorVisited.add(currentAncestorId);
    const currentAncestor = byId.get(currentAncestorId);
    if (!currentAncestor || currentAncestor.parentTaskId === currentAncestor.taskId) {
      break;
    }
    currentAncestorId = currentAncestor.parentTaskId;
  }
  const ancestorSet = new Set(ancestorTaskIds);
  const forbiddenDependencyIds = dependencies.filter((depId) => ancestorSet.has(depId));
  if (forbiddenDependencyIds.length > 0) {
    throw new TaskboardStoreError(
      `dependencies cannot include parent/ancestor tasks: ${forbiddenDependencyIds.join(", ")}`,
      "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN",
      {
        task_id: taskId,
        parent_task_id: parentTaskId,
        ancestor_task_ids: ancestorTaskIds,
        forbidden_dependency_ids: forbiddenDependencyIds
      }
    );
  }

  const depsByTask = new Map<string, string[]>();
  for (const task of state.tasks) {
    depsByTask.set(task.taskId, [...task.dependencies]);
  }
  depsByTask.set(taskId, [...dependencies]);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dfs = (node: string): boolean => {
    if (visiting.has(node)) {
      return true;
    }
    if (visited.has(node)) {
      return false;
    }
    visiting.add(node);
    const deps = depsByTask.get(node) ?? [];
    for (const dep of deps) {
      if (dfs(dep)) {
        return true;
      }
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  if (dfs(taskId)) {
    throw new TaskboardStoreError("dependency cycle detected", "TASK_DEPENDENCY_CYCLE");
  }
}

function collectUnsatisfiedDependencies(
  task: TaskRecord,
  byId: Map<string, TaskRecord>
): string[] {
  if (task.dependencies.length === 0) {
    return [];
  }
  const unsatisfied: string[] = [];
  for (const depId of task.dependencies) {
    const dep = byId.get(depId);
    if (!dep || dep.state !== "DONE") {
      unsatisfied.push(depId);
    }
  }
  return unsatisfied;
}

function collectAncestorChain(task: TaskRecord, byId: Map<string, TaskRecord>): TaskRecord[] {
  const chain: TaskRecord[] = [];
  const visited = new Set<string>([task.taskId]);
  let currentParentId = task.parentTaskId;
  while (currentParentId && !visited.has(currentParentId)) {
    const parent = byId.get(currentParentId);
    if (!parent) {
      break;
    }
    chain.push(parent);
    visited.add(parent.taskId);
    if (parent.parentTaskId === parent.taskId) {
      break;
    }
    currentParentId = parent.parentTaskId;
  }
  return chain;
}

export interface TaskDependencyGateStatus {
  satisfied: boolean;
  blockingTaskIds: string[];
  unsatisfiedDependencyIds: string[];
}

export function getTaskDependencyGateStatus(
  task: TaskRecord,
  byId: Map<string, TaskRecord>
): TaskDependencyGateStatus {
  const blockingTaskIds = new Set<string>();
  const unsatisfiedDependencyIds = new Set<string>();

  const ownUnsatisfied = collectUnsatisfiedDependencies(task, byId);
  if (ownUnsatisfied.length > 0) {
    blockingTaskIds.add(task.taskId);
    for (const depId of ownUnsatisfied) {
      unsatisfiedDependencyIds.add(depId);
    }
  }

  const ancestors = collectAncestorChain(task, byId);
  for (const ancestor of ancestors) {
    const ancestorUnsatisfied = collectUnsatisfiedDependencies(ancestor, byId);
    if (ancestorUnsatisfied.length === 0) {
      continue;
    }
    blockingTaskIds.add(ancestor.taskId);
    for (const depId of ancestorUnsatisfied) {
      unsatisfiedDependencyIds.add(depId);
    }
  }

  return {
    satisfied: blockingTaskIds.size === 0,
    blockingTaskIds: Array.from(blockingTaskIds),
    unsatisfiedDependencyIds: Array.from(unsatisfiedDependencyIds)
  };
}

export function isTaskDependencyGateOpen(
  task: TaskRecord,
  byId: Map<string, TaskRecord>
): boolean {
  return getTaskDependencyGateStatus(task, byId).satisfied;
}

function recomputeParentStates(tasks: TaskRecord[]): boolean {
  const childrenByParent = buildChildrenMap(tasks);
  let changed = false;
  const byId = taskById(tasks);
  const sorted = [...tasks].sort((a, b) => b.taskId.localeCompare(a.taskId));
  for (const task of sorted) {
    const children = (childrenByParent.get(task.taskId) ?? []).filter((child) => child.taskId !== task.taskId);
    if (children.length === 0) {
      continue;
    }
    let nextState: TaskState;
    if (!isTaskDependencyGateOpen(task, byId)) {
      nextState = "BLOCKED_DEP";
    } else if (children.every((child) => child.state === "DONE" || child.state === "CANCELED")) {
      nextState = "DONE";
    } else {
      nextState = "IN_PROGRESS";
    }
    const current = byId.get(task.taskId);
    if (current && current.state !== nextState) {
      current.state = nextState;
      current.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  return changed;
}

export async function readTaskboard(paths: ProjectPaths, projectId: string): Promise<TaskboardState> {
  return readJsonFile<TaskboardState>(paths.taskboardFile, defaultTaskboard(projectId));
}

export async function writeTaskboard(paths: ProjectPaths, state: TaskboardState): Promise<void> {
  await writeJsonFile(paths.taskboardFile, state);
}

export async function listTasks(paths: ProjectPaths, projectId: string): Promise<TaskRecord[]> {
  const state = await readTaskboard(paths, projectId);
  return state.tasks;
}

export async function getTask(paths: ProjectPaths, projectId: string, taskId: string): Promise<TaskRecord | null> {
  const state = await readTaskboard(paths, projectId);
  const normalized = normalizeTaskId(taskId);
  return state.tasks.find((t) => t.taskId === normalized) ?? null;
}

export async function createTask(
  paths: ProjectPaths,
  projectId: string,
  input: TaskCreateInput
): Promise<TaskRecord> {
  const state = await readTaskboard(paths, projectId);
  const taskId = normalizeTaskId(input.taskId);
  if (state.tasks.some((task) => task.taskId === taskId)) {
    throw new TaskboardStoreError(`task '${taskId}' already exists`, "TASK_EXISTS");
  }
  const taskKind = normalizeTaskKind(input.taskKind);
  const relation = assertParentAndRoot(state, input, taskId, taskKind);
  const dependencies = normalizeStringArray(input.dependencies);
  assertDependenciesValid(state, taskId, relation.parentTaskId, relation.rootTaskId, dependencies);
  const now = new Date().toISOString();
  const task: TaskRecord = {
    taskId,
    taskKind,
    parentTaskId: relation.parentTaskId,
    rootTaskId: relation.rootTaskId,
    title: input.title.trim() || taskId,
    creatorRole: input.creatorRole?.trim() || undefined,
    creatorSessionId: input.creatorSessionId?.trim() || undefined,
    ownerRole: normalizeOwnerRole(input.ownerRole),
    ownerSession: input.ownerSession?.trim() || undefined,
    state: normalizeTaskState(input.state),
    priority: normalizePriority(input.priority),
    writeSet: normalizeStringArray(input.writeSet),
    dependencies,
    acceptance: normalizeStringArray(input.acceptance),
    artifacts: normalizeStringArray(input.artifacts),
    alert: input.alert?.trim() || undefined,
    grantedAt: undefined,
    closedAt: undefined,
    closeReportId: undefined,
    createdAt: now,
    updatedAt: now,
    lastSummary: undefined
  };
  state.tasks.push(task);
  state.updatedAt = now;
  await writeTaskboard(paths, state);
  return task;
}

export async function patchTask(
  paths: ProjectPaths,
  projectId: string,
  taskId: string,
  patch: TaskPatchInput,
  options: UpsertOptions = { allowCreate: false }
): Promise<{ task: TaskRecord; previousState?: TaskState; created: boolean }> {
  const state = await readTaskboard(paths, projectId);
  const normalizedTaskId = normalizeTaskId(taskId);
  const idx = state.tasks.findIndex((task) => task.taskId === normalizedTaskId);
  if (idx < 0) {
    if (!options.allowCreate) {
      throw new TaskboardStoreError(`task '${normalizedTaskId}' not found`, "TASK_NOT_FOUND");
    }
    const createdTask = await createTask(paths, projectId, {
      taskId: normalizedTaskId,
      taskKind: patch.taskKind ?? "EXECUTION",
      parentTaskId: patch.parentTaskId,
      rootTaskId: patch.rootTaskId,
      title: patch.title ?? normalizedTaskId,
      creatorRole: patch.creatorRole,
      creatorSessionId: patch.creatorSessionId,
      ownerRole: patch.ownerRole ?? "unknown",
      ownerSession: patch.ownerSession ?? undefined,
      state: patch.state ?? "PLANNED",
      priority: patch.priority,
      writeSet: patch.writeSet,
      dependencies: patch.dependencies,
      acceptance: patch.acceptance,
      artifacts: patch.artifacts,
      alert: patch.alert ?? undefined
    });
    return { task: createdTask, created: true };
  }

  const existing = state.tasks[idx];
  const previousState = existing.state;
  const nextParentTaskId = patch.parentTaskId ? normalizeTaskId(patch.parentTaskId) : existing.parentTaskId;
  const nextRootTaskId = patch.rootTaskId ? normalizeTaskId(patch.rootTaskId) : existing.rootTaskId;
  const nextDependencies = patch.dependencies ? normalizeStringArray(patch.dependencies) : existing.dependencies;
  const tempWithoutCurrent = { ...state, tasks: state.tasks.filter((task) => task.taskId !== normalizedTaskId) };
  assertDependenciesValid(
    tempWithoutCurrent,
    normalizedTaskId,
    nextParentTaskId,
    nextRootTaskId,
    nextDependencies
  );
  const now = new Date().toISOString();
  const next: TaskRecord = {
    ...existing,
    taskKind: patch.taskKind ?? existing.taskKind,
    parentTaskId: nextParentTaskId,
    rootTaskId: nextRootTaskId,
    title: patch.title?.trim() || existing.title,
    creatorRole: patch.creatorRole === undefined ? existing.creatorRole : patch.creatorRole?.trim() || undefined,
    creatorSessionId:
      patch.creatorSessionId === undefined
        ? existing.creatorSessionId
        : patch.creatorSessionId?.trim() || undefined,
    ownerRole: patch.ownerRole ? normalizeOwnerRole(patch.ownerRole) : existing.ownerRole,
    ownerSession:
      patch.ownerSession === null
        ? undefined
        : patch.ownerSession?.trim() || existing.ownerSession,
    state: patch.state ? normalizeTaskState(patch.state) : existing.state,
    priority: patch.priority === undefined ? existing.priority : normalizePriority(patch.priority),
    writeSet: patch.writeSet ? normalizeStringArray(patch.writeSet) : existing.writeSet,
    dependencies: nextDependencies,
    acceptance: patch.acceptance ? normalizeStringArray(patch.acceptance) : existing.acceptance,
    artifacts: patch.artifacts ? normalizeStringArray(patch.artifacts) : existing.artifacts,
    alert: patch.alert === null ? undefined : patch.alert?.trim() || existing.alert,
    grantedAt: patch.grantedAt === null ? undefined : patch.grantedAt ?? existing.grantedAt,
    closedAt: patch.closedAt === null ? undefined : patch.closedAt ?? existing.closedAt,
    closeReportId: patch.closeReportId === null ? undefined : patch.closeReportId ?? existing.closeReportId,
    updatedAt: now,
    lastSummary: patch.lastSummary ?? existing.lastSummary
  };
  state.tasks[idx] = next;
  state.updatedAt = now;
  await writeTaskboard(paths, state);
  return { task: next, previousState, created: false };
}

export async function ensureProjectRootTask(paths: ProjectPaths, projectId: string): Promise<TaskRecord> {
  const rootTaskId = `project-root-${projectId}`;
  const existing = (await listTasks(paths, projectId)).find((task) => task.taskId === rootTaskId);
  if (existing) {
    return existing;
  }
  return createTask(paths, projectId, {
    taskId: rootTaskId,
    taskKind: "PROJECT_ROOT",
    title: "Project Root",
    ownerRole: "manager",
    state: "READY"
  });
}

export async function ensureUserRootTask(
  paths: ProjectPaths,
  projectId: string,
  input: { taskId?: string; title?: string; creatorRole?: string; creatorSessionId?: string }
): Promise<TaskRecord> {
  const projectRoot = await ensureProjectRootTask(paths, projectId);
  const taskId = normalizeTaskId(input.taskId ?? `user-root-${Date.now()}`);
  const existing = (await listTasks(paths, projectId)).find((task) => task.taskId === taskId);
  if (existing) {
    return existing;
  }
  return createTask(paths, projectId, {
    taskId,
    taskKind: "USER_ROOT",
    parentTaskId: projectRoot.taskId,
    title: input.title ?? "User Root Task",
    creatorRole: input.creatorRole,
    creatorSessionId: input.creatorSessionId,
    ownerRole: "manager",
    state: "READY"
  });
}

export async function recomputeRunnableStates(
  paths: ProjectPaths,
  projectId: string
): Promise<{ changedTaskIds: string[]; tasks: TaskRecord[] }> {
  const state = await readTaskboard(paths, projectId);
  const byId = taskById(state.tasks);
  const changedTaskIds = new Set<string>();
  const now = new Date().toISOString();
  for (const task of state.tasks) {
    if (TERMINAL_TASK_STATES.has(task.state)) {
      continue;
    }
    if (ACTIVE_TASK_STATES.has(task.state)) {
      continue;
    }
    if (PRESERVED_STATES.has(task.state)) {
      continue;
    }
    const hasChildren = state.tasks.some((item) => item.parentTaskId === task.taskId && item.taskId !== task.taskId);
    if (hasChildren) {
      continue;
    }
    const depsReady = isTaskDependencyGateOpen(task, byId);
    const nextState = depsReady ? "READY" : "BLOCKED_DEP";
    if (task.state !== nextState) {
      task.state = nextState;
      task.updatedAt = now;
      changedTaskIds.add(task.taskId);
    }
  }
  if (recomputeParentStates(state.tasks)) {
    for (const task of state.tasks) {
      changedTaskIds.add(task.taskId);
    }
  }
  if (changedTaskIds.size > 0) {
    state.updatedAt = now;
    await writeTaskboard(paths, state);
  }
  return { changedTaskIds: Array.from(changedTaskIds), tasks: state.tasks };
}

export async function listRunnableTasksByRole(
  paths: ProjectPaths,
  projectId: string
): Promise<Array<{ role: string; tasks: TaskRecord[] }>> {
  const { tasks } = await recomputeRunnableStates(paths, projectId);
  const byId = taskById(tasks);
  const byRole = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    if (task.state !== "READY") {
      continue;
    }
    if (!isTaskDependencyGateOpen(task, byId)) {
      continue;
    }
    if (!task.ownerRole) {
      continue;
    }
    if (!byRole.has(task.ownerRole)) {
      byRole.set(task.ownerRole, []);
    }
    byRole.get(task.ownerRole)!.push(task);
  }
  const rows = Array.from(byRole.entries()).map(([role, roleTasks]) => ({
    role,
    tasks: [...roleTasks].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || Date.parse(a.createdAt) - Date.parse(b.createdAt))
  }));
  rows.sort((a, b) => a.role.localeCompare(b.role));
  return rows;
}

export async function markTaskGranted(
  paths: ProjectPaths,
  projectId: string,
  taskId: string
): Promise<TaskRecord> {
  const patched = await patchTask(paths, projectId, taskId, {
    state: "DISPATCHED",
    grantedAt: new Date().toISOString()
  });
  return patched.task;
}

export async function updateTaskboardFromTaskReport(
  paths: ProjectPaths,
  projectId: string,
  report: TaskReport
): Promise<{ updatedTaskIds: string[] }> {
  const updatedTaskIds: string[] = [];
  for (const result of report.results) {
    const nextState = result.outcome;
    const isTerminal = nextState === "DONE" || nextState === "CANCELED" || nextState === "BLOCKED_DEP";
    const patched = await patchTask(paths, projectId, result.taskId, {
      state: nextState,
      closedAt: isTerminal ? new Date().toISOString() : undefined,
      closeReportId: isTerminal ? report.reportId : undefined,
      lastSummary: result.summary ?? report.summary
    });
    if (patched.previousState !== nextState) {
      updatedTaskIds.push(patched.task.taskId);
    }
  }
  await recomputeRunnableStates(paths, projectId);
  return { updatedTaskIds };
}

export async function upsertTaskFromNextAction(
  paths: ProjectPaths,
  projectId: string,
  action: NextActionInput,
  defaults: {
    taskId: string;
    ownerRole: string;
    ownerSession?: string;
    title: string;
    parentTaskId: string;
    rootTaskId?: string;
    dependencyTaskId?: string;
  }
): Promise<{ task: TaskRecord; previousState?: TaskState; created: boolean }> {
  const dependencies = normalizeStringArray([
    ...(action.dependencies ?? []),
    ...(defaults.dependencyTaskId ? [defaults.dependencyTaskId] : [])
  ]);
  return patchTask(
    paths,
    projectId,
    action.taskId ?? defaults.taskId,
    {
      taskKind: "EXECUTION",
      parentTaskId: defaults.parentTaskId,
      rootTaskId: defaults.rootTaskId,
      title: action.title ?? defaults.title,
      ownerRole: action.toRole ?? defaults.ownerRole,
      ownerSession: defaults.ownerSession ?? null,
      state: "PLANNED",
      writeSet: action.writeSet ?? [],
      dependencies,
      acceptance: action.acceptance ?? [],
      artifacts: action.artifacts ?? []
    },
    { allowCreate: true }
  );
}
