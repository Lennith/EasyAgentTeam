import path from "node:path";
import type {
  WorkflowBlockReasonCode,
  WorkflowRunRecord,
  WorkflowRunRegistryState,
  WorkflowRunRuntimeState,
  WorkflowRunMode,
  WorkflowRunSpawnState,
  WorkflowRunState,
  WorkflowRunTaskRecord,
  WorkflowTaskBlockReason,
  WorkflowTaskRuntimeRecord,
  WorkflowTaskState,
  WorkflowTemplateRecord,
  WorkflowTemplateRegistryState,
  WorkflowTemplateTaskRecord
} from "../../../domain/models.js";
import { getRepository, getUnitOfWork } from "../shared/runtime.js";
import {
  ensureWorkflowRunRuntime,
  readWorkflowRunTaskRuntimeState,
  writeWorkflowRunTaskRuntimeState
} from "./runtime-repository.js";
import { traceWorkflowPerfSpan } from "../../../services/workflow-perf-trace.js";
import { isLegacyAmbiguousDoneState } from "../shared/legacy-task-state.js";

export class WorkflowStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_TEMPLATE_ID"
      | "INVALID_RUN_ID"
      | "INVALID_TEMPLATE"
      | "INVALID_RUN"
      | "TEMPLATE_EXISTS"
      | "TEMPLATE_NOT_FOUND"
      | "RUN_EXISTS"
      | "RUN_NOT_FOUND"
  ) {
    super(message);
  }
}

interface WorkflowPaths {
  workflowsRootDir: string;
  templatesFile: string;
  runsFile: string;
  runsRootDir: string;
}

interface CreateWorkflowTemplateInput {
  templateId: string;
  name: string;
  description?: string;
  tasks: WorkflowTemplateTaskRecord[];
  routeTable?: Record<string, string[]>;
  taskAssignRouteTable?: Record<string, string[]>;
  routeDiscussRounds?: Record<string, Record<string, number>>;
  defaultVariables?: Record<string, string>;
}

interface PatchWorkflowTemplateInput {
  name?: string;
  description?: string | null;
  tasks?: WorkflowTemplateTaskRecord[];
  routeTable?: Record<string, string[]>;
  taskAssignRouteTable?: Record<string, string[]>;
  routeDiscussRounds?: Record<string, Record<string, number>>;
  defaultVariables?: Record<string, string>;
}

interface CreateWorkflowRunInput {
  runId: string;
  templateId: string;
  name: string;
  description?: string;
  workspacePath: string;
  variables?: Record<string, string>;
  taskOverrides?: Record<string, string>;
  tasks: WorkflowRunTaskRecord[];
  routeTable?: Record<string, string[]>;
  taskAssignRouteTable?: Record<string, string[]>;
  routeDiscussRounds?: Record<string, Record<string, number>>;
  mode?: WorkflowRunMode;
  loopEnabled?: boolean;
  scheduleEnabled?: boolean;
  scheduleExpression?: string;
  isScheduleSeed?: boolean;
  originRunId?: string;
  lastSpawnedRunId?: string;
  spawnState?: WorkflowRunSpawnState;
  autoDispatchEnabled?: boolean;
  autoDispatchRemaining?: number;
  autoDispatchInitialRemaining?: number;
  holdEnabled?: boolean;
  reminderMode?: "backoff" | "fixed_interval";
  roleSessionMap?: Record<string, string>;
}

interface PatchWorkflowRunInput {
  status?: WorkflowRunState;
  lastHeartbeatAt?: string | null;
  startedAt?: string | null;
  stoppedAt?: string | null;
  description?: string | null;
  runtime?: WorkflowRunRuntimeState | null;
  tasks?: WorkflowRunTaskRecord[];
  mode?: WorkflowRunMode;
  loopEnabled?: boolean;
  scheduleEnabled?: boolean;
  scheduleExpression?: string | null;
  isScheduleSeed?: boolean;
  originRunId?: string | null;
  lastSpawnedRunId?: string | null;
  spawnState?: WorkflowRunSpawnState | null;
  autoDispatchEnabled?: boolean;
  autoDispatchRemaining?: number;
  autoDispatchInitialRemaining?: number;
  holdEnabled?: boolean;
  reminderMode?: "backoff" | "fixed_interval";
  roleSessionMap?: Record<string, string>;
}

class WorkflowWriteMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const waitFor = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await waitFor.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const workflowWriteMutex = new WorkflowWriteMutex();
const repository = getRepository();
const unitOfWork = getUnitOfWork();

function getWorkflowPaths(dataRoot: string): WorkflowPaths {
  const workflowsRootDir = path.join(dataRoot, "workflows");
  return {
    workflowsRootDir,
    templatesFile: path.join(workflowsRootDir, "templates.json"),
    runsFile: path.join(workflowsRootDir, "runs.json"),
    runsRootDir: path.join(workflowsRootDir, "runs")
  };
}

function defaultTemplateRegistry(): WorkflowTemplateRegistryState {
  return {
    schemaVersion: "1.0",
    updatedAt: new Date().toISOString(),
    templates: []
  };
}

function defaultRunRegistry(): WorkflowRunRegistryState {
  return {
    schemaVersion: "2.0",
    updatedAt: new Date().toISOString(),
    runs: []
  };
}

function assertTemplateId(templateIdRaw: string): string {
  const templateId = templateIdRaw.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(templateId)) {
    throw new WorkflowStoreError("template_id must match /^[a-zA-Z0-9_-]+$/", "INVALID_TEMPLATE_ID");
  }
  return templateId;
}

function assertRunId(runIdRaw: string): string {
  const runId = runIdRaw.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new WorkflowStoreError("run_id must match /^[a-zA-Z0-9_-]+$/", "INVALID_RUN_ID");
  }
  return runId;
}

function normalizeStringMap(raw: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const entries = Object.entries(raw)
    .map(([key, value]) => [key.trim(), String(value).trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0);
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function normalizeRoleSessionMap(raw: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const entries = Object.entries(raw)
    .map(([role, sessionId]) => [role.trim(), String(sessionId).trim()] as const)
    .filter(([role, sessionId]) => role.length > 0 && sessionId.length > 0);
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function normalizeRunMode(raw: unknown): WorkflowRunMode | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "none" || normalized === "loop" || normalized === "schedule") {
    return normalized;
  }
  return undefined;
}

function normalizeBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") {
    return raw;
  }
  return undefined;
}

function normalizeMaybeRunId(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed || !/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function normalizeScheduleExpression(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSpawnState(raw: unknown): WorkflowRunSpawnState | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const normalized: WorkflowRunSpawnState = {};
  const isActive = normalizeBoolean(record.isActive ?? record.is_active);
  if (isActive !== undefined) {
    normalized.isActive = isActive;
  }
  const activeRunId = normalizeMaybeRunId(record.activeRunId ?? record.active_run_id);
  if (activeRunId) {
    normalized.activeRunId = activeRunId;
  }
  const lastWindowKey =
    typeof (record.lastWindowKey ?? record.last_window_key) === "string"
      ? String(record.lastWindowKey ?? record.last_window_key).trim()
      : "";
  if (lastWindowKey) {
    normalized.lastWindowKey = lastWindowKey;
  }
  const lastSpawnedRunId = normalizeMaybeRunId(record.lastSpawnedRunId ?? record.last_spawned_run_id);
  if (lastSpawnedRunId) {
    normalized.lastSpawnedRunId = lastSpawnedRunId;
  }
  const stringFields: Array<
    [
      "lastSpawnedAt" | "lastTriggeredAt" | "lastWindowStartAt" | "lastWindowEndAt" | "nextAvailableAt",
      unknown
    ]
  > = [
    ["lastSpawnedAt", record.lastSpawnedAt ?? record.last_spawned_at],
    ["lastTriggeredAt", record.lastTriggeredAt ?? record.last_triggered_at],
    ["lastWindowStartAt", record.lastWindowStartAt ?? record.last_window_start_at],
    ["lastWindowEndAt", record.lastWindowEndAt ?? record.last_window_end_at],
    ["nextAvailableAt", record.nextAvailableAt ?? record.next_available_at]
  ];
  for (const [field, value] of stringFields) {
    if (typeof value === "string" && value.trim().length > 0) {
      normalized[field] = value.trim();
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeRouteTable(raw: Record<string, string[]> | undefined): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const next: Record<string, string[]> = {};
  for (const [from, toList] of Object.entries(raw)) {
    const fromKey = from.trim();
    if (!fromKey) {
      continue;
    }
    if (!Array.isArray(toList)) {
      next[fromKey] = [];
      continue;
    }
    next[fromKey] = Array.from(new Set(toList.map((item) => String(item).trim()).filter((item) => item.length > 0)));
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeRouteDiscussRounds(
  raw: Record<string, Record<string, number>> | undefined
): Record<string, Record<string, number>> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const next: Record<string, Record<string, number>> = {};
  for (const [from, values] of Object.entries(raw)) {
    const fromKey = from.trim();
    if (!fromKey || !values || typeof values !== "object") {
      continue;
    }
    const normalized: Record<string, number> = {};
    for (const [to, rounds] of Object.entries(values)) {
      const toKey = to.trim();
      const parsed = Math.floor(Number(rounds));
      if (!toKey || !Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
        continue;
      }
      normalized[toKey] = parsed;
    }
    if (Object.keys(normalized).length > 0) {
      next[fromKey] = normalized;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeTask(task: WorkflowTemplateTaskRecord, index: number): WorkflowTemplateTaskRecord {
  const taskId = task.taskId?.trim();
  const title = task.title?.trim();
  const ownerRole = task.ownerRole?.trim();
  if (!taskId || !title || !ownerRole) {
    throw new WorkflowStoreError(`task[${index}] requires taskId/title/ownerRole`, "INVALID_TEMPLATE");
  }
  return {
    taskId,
    title,
    ownerRole,
    parentTaskId: task.parentTaskId?.trim() || undefined,
    dependencies: task.dependencies?.map((item) => item.trim()).filter((item) => item.length > 0),
    writeSet: task.writeSet?.map((item) => item.trim()).filter((item) => item.length > 0),
    acceptance: task.acceptance?.map((item) => item.trim()).filter((item) => item.length > 0),
    artifacts: task.artifacts?.map((item) => item.trim()).filter((item) => item.length > 0)
  };
}

function normalizeRunTask(task: WorkflowRunTaskRecord, index: number): WorkflowRunTaskRecord {
  const base = normalizeTask(task, index);
  const resolvedTitle = task.resolvedTitle?.trim();
  if (!resolvedTitle) {
    throw new WorkflowStoreError(`run task[${index}] requires resolvedTitle`, "INVALID_RUN");
  }
  return {
    ...base,
    resolvedTitle,
    creatorRole: task.creatorRole?.trim() || undefined,
    creatorSessionId: task.creatorSessionId?.trim() || undefined
  };
}

async function ensureWorkflowRuntime(dataRoot: string): Promise<WorkflowPaths> {
  const paths = getWorkflowPaths(dataRoot);
  await repository.ensureDirectory(paths.workflowsRootDir);
  await repository.ensureDirectory(paths.runsRootDir);
  await repository.ensureFile(paths.templatesFile, `${JSON.stringify(defaultTemplateRegistry(), null, 2)}\n`);
  await repository.ensureFile(paths.runsFile, `${JSON.stringify(defaultRunRegistry(), null, 2)}\n`);
  return paths;
}

function mapLegacyWorkflowState(raw: string | undefined): WorkflowTaskState {
  const state = String(raw ?? "").trim().toUpperCase();
  if (isLegacyAmbiguousDoneState(state)) {
    return "DONE";
  }
  switch (state) {
    case "READY":
    case "DISPATCHED":
    case "IN_PROGRESS":
    case "BLOCKED_DEP":
    case "DONE":
    case "CANCELED":
    case "PLANNED":
      return state as WorkflowTaskState;
    case "CREATED":
      return "PLANNED";
    case "FAILED":
      return "CANCELED";
    default:
      return "PLANNED";
  }
}

function normalizeBlockReasonCode(raw: unknown): WorkflowBlockReasonCode | undefined {
  const value = typeof raw === "string" ? raw : "";
  if (
    value === "DEP_UNSATISFIED" ||
    value === "RUN_NOT_RUNNING" ||
    value === "INVALID_TRANSITION" ||
    value === "TASK_NOT_FOUND" ||
    value === "TASK_ALREADY_TERMINAL"
  ) {
    return value;
  }
  return undefined;
}

function normalizeLegacyBlockedReasons(raw: unknown): WorkflowTaskBlockReason[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const record = item as Record<string, unknown>;
      const code = typeof record.code === "string" ? record.code : "DEP_UNSATISFIED";
      const deps = Array.isArray(record.dependencyTaskIds)
        ? record.dependencyTaskIds.map((value) => String(value).trim()).filter((value) => value.length > 0)
        : undefined;
      const message = typeof record.message === "string" && record.message.trim().length > 0 ? record.message : undefined;
      return { code: code as WorkflowTaskBlockReason["code"], dependencyTaskIds: deps, message };
    });
}

function buildInitialRuntimeFromTasks(tasks: WorkflowRunTaskRecord[]): WorkflowRunRuntimeState {
  const now = new Date().toISOString();
  return {
    initializedAt: now,
    updatedAt: now,
    transitionSeq: tasks.length,
    tasks: tasks.map((task, idx) => ({
      taskId: task.taskId,
      state: "PLANNED",
      blockedBy: [],
      blockedReasons: [],
      lastTransitionAt: now,
      transitionCount: 1,
      transitions: [{ seq: idx + 1, at: now, fromState: null, toState: "PLANNED" }]
    }))
  };
}

async function normalizeRunRecord(
  dataRoot: string,
  raw: Record<string, unknown>
): Promise<{ record: WorkflowRunRecord; migrated: boolean; runtime: WorkflowRunRuntimeState | null }> {
  const runId = assertRunId(String(raw.runId ?? raw.run_id ?? ""));
  const templateId = assertTemplateId(String(raw.templateId ?? raw.template_id ?? ""));
  const nameRaw = String(raw.name ?? "").trim();
  if (!nameRaw) {
    throw new WorkflowStoreError("run name is required", "INVALID_RUN");
  }
  const workspacePath = path.resolve(String(raw.workspacePath ?? raw.workspace_path ?? ""));
  if (!workspacePath) {
    throw new WorkflowStoreError("workspacePath is required", "INVALID_RUN");
  }
  const tasksRaw = Array.isArray(raw.tasks) ? raw.tasks : [];
  const normalizedTasks = tasksRaw.map((task, index) => normalizeRunTask(task as WorkflowRunTaskRecord, index));
  if (normalizedTasks.length === 0) {
    throw new WorkflowStoreError("run tasks must not be empty", "INVALID_RUN");
  }

  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;
  const statusRaw = String(raw.status ?? "created");
  const status: WorkflowRunState =
    statusRaw === "created" || statusRaw === "running" || statusRaw === "stopped" || statusRaw === "finished" || statusRaw === "failed"
      ? statusRaw
      : "created";
  const modeFromRaw = normalizeRunMode(raw.mode);
  const loopEnabledRaw = normalizeBoolean(raw.loopEnabled ?? raw.loop_enabled);
  const scheduleEnabledRaw = normalizeBoolean(raw.scheduleEnabled ?? raw.schedule_enabled);
  const loopEnabled = loopEnabledRaw ?? modeFromRaw === "loop";
  const scheduleEnabled = scheduleEnabledRaw ?? modeFromRaw === "schedule";
  const mode: WorkflowRunMode = modeFromRaw ?? (scheduleEnabled ? "schedule" : loopEnabled ? "loop" : "none");
  const autoDispatchEnabled =
    typeof raw.autoDispatchEnabled === "boolean"
      ? raw.autoDispatchEnabled
      : typeof raw.auto_dispatch_enabled === "boolean"
        ? raw.auto_dispatch_enabled
        : true;
  const autoDispatchRemainingRaw =
    typeof raw.autoDispatchRemaining === "number"
      ? raw.autoDispatchRemaining
      : typeof raw.auto_dispatch_remaining === "number"
        ? raw.auto_dispatch_remaining
        : 5;
  const autoDispatchRemaining = Number.isFinite(autoDispatchRemainingRaw)
    ? Math.max(0, Math.floor(autoDispatchRemainingRaw))
    : 5;
  const autoDispatchInitialRemainingRaw =
    typeof raw.autoDispatchInitialRemaining === "number"
      ? raw.autoDispatchInitialRemaining
      : typeof raw.auto_dispatch_initial_remaining === "number"
        ? raw.auto_dispatch_initial_remaining
        : autoDispatchRemaining;
  const autoDispatchInitialRemaining = Number.isFinite(autoDispatchInitialRemainingRaw)
    ? Math.max(0, Math.floor(autoDispatchInitialRemainingRaw))
    : autoDispatchRemaining;
  const holdEnabled =
    typeof raw.holdEnabled === "boolean"
      ? raw.holdEnabled
      : typeof raw.hold_enabled === "boolean"
        ? raw.hold_enabled
        : false;
  const reminderModeRaw =
    typeof raw.reminderMode === "string"
      ? raw.reminderMode
      : typeof raw.reminder_mode === "string"
        ? raw.reminder_mode
        : "backoff";
  const reminderMode = reminderModeRaw === "fixed_interval" ? "fixed_interval" : "backoff";
  const scheduleExpression = normalizeScheduleExpression(raw.scheduleExpression ?? raw.schedule_expression);
  const isScheduleSeedRaw = normalizeBoolean(raw.isScheduleSeed ?? raw.is_schedule_seed);
  const isScheduleSeed = isScheduleSeedRaw ?? (mode === "schedule" && scheduleEnabled);
  const record: WorkflowRunRecord = {
    schemaVersion: "2.0",
    runId,
    templateId,
    name: nameRaw,
    description: typeof raw.description === "string" && raw.description.trim().length > 0 ? raw.description.trim() : undefined,
    workspacePath,
    routeTable: normalizeRouteTable(raw.routeTable as Record<string, string[]> | undefined),
    taskAssignRouteTable: normalizeRouteTable(raw.taskAssignRouteTable as Record<string, string[]> | undefined),
    routeDiscussRounds: normalizeRouteDiscussRounds(
      raw.routeDiscussRounds as Record<string, Record<string, number>> | undefined
    ),
    variables: normalizeStringMap(raw.variables as Record<string, string> | undefined),
    taskOverrides: normalizeStringMap(raw.taskOverrides as Record<string, string> | undefined),
    tasks: normalizedTasks,
    status,
    mode,
    loopEnabled,
    scheduleEnabled,
    scheduleExpression,
    isScheduleSeed,
    originRunId: normalizeMaybeRunId(raw.originRunId ?? raw.origin_run_id),
    lastSpawnedRunId: normalizeMaybeRunId(raw.lastSpawnedRunId ?? raw.last_spawned_run_id),
    spawnState: normalizeSpawnState(raw.spawnState ?? raw.spawn_state),
    autoDispatchEnabled,
    autoDispatchRemaining,
    autoDispatchInitialRemaining,
    holdEnabled,
    reminderMode,
    createdAt,
    updatedAt,
    roleSessionMap: normalizeRoleSessionMap(
      (raw.roleSessionMap as Record<string, string> | undefined) ??
        (raw.role_session_map as Record<string, string> | undefined)
    ),
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
    stoppedAt: typeof raw.stoppedAt === "string" ? raw.stoppedAt : undefined,
    lastHeartbeatAt: typeof raw.lastHeartbeatAt === "string" ? raw.lastHeartbeatAt : undefined
  };

  const runtimeRaw = raw.runtime as Record<string, unknown> | undefined;
  let runtime: WorkflowRunRuntimeState | null = null;
  if (runtimeRaw && typeof runtimeRaw === "object") {
    const runtimeTasksRaw = Array.isArray(runtimeRaw.tasks) ? runtimeRaw.tasks : Array.isArray(runtimeRaw.steps) ? runtimeRaw.steps : [];
    runtime = {
      initializedAt:
        typeof runtimeRaw.initializedAt === "string" && runtimeRaw.initializedAt.trim().length > 0
          ? runtimeRaw.initializedAt
          : createdAt,
      updatedAt:
        typeof runtimeRaw.updatedAt === "string" && runtimeRaw.updatedAt.trim().length > 0
          ? runtimeRaw.updatedAt
          : updatedAt,
      transitionSeq: Number.isFinite(runtimeRaw.transitionSeq) ? Math.max(0, Math.floor(Number(runtimeRaw.transitionSeq))) : 0,
      tasks: runtimeTasksRaw
        .filter((item) => item && typeof item === "object")
        .map((item, index) => {
          const row = item as Record<string, unknown>;
          const taskId = String(row.taskId ?? row.task_id ?? "").trim();
          const mappedState = mapLegacyWorkflowState(typeof row.state === "string" ? row.state : undefined);
          const transitionsRaw = Array.isArray(row.transitions) ? row.transitions : [];
          const transitions = transitionsRaw
            .filter((entry) => entry && typeof entry === "object")
            .map((entry, idx) => {
              const transition = entry as Record<string, unknown>;
              return {
                seq: Number.isFinite(transition.seq) ? Math.max(0, Math.floor(Number(transition.seq))) : idx + 1,
                at: typeof transition.at === "string" ? transition.at : updatedAt,
                fromState:
                  transition.fromState === null || transition.fromState === undefined
                    ? null
                    : mapLegacyWorkflowState(String(transition.fromState)),
                toState: mapLegacyWorkflowState(String(transition.toState ?? mappedState)),
                reasonCode: normalizeBlockReasonCode(transition.reasonCode),
                summary: typeof transition.summary === "string" ? transition.summary : undefined
              };
            });
          const normalized: WorkflowTaskRuntimeRecord = {
            taskId,
            state: mappedState,
            blockedBy: Array.isArray(row.blockedBy)
              ? row.blockedBy.map((item) => String(item).trim()).filter((item) => item.length > 0)
              : [],
            blockedReasons: normalizeLegacyBlockedReasons(row.blockedReasons),
            lastSummary: typeof row.lastSummary === "string" ? row.lastSummary : undefined,
            blockers: Array.isArray(row.blockers)
              ? row.blockers.map((item) => String(item).trim()).filter((item) => item.length > 0)
              : undefined,
            lastTransitionAt: typeof row.lastTransitionAt === "string" ? row.lastTransitionAt : updatedAt,
            transitionCount: Number.isFinite(row.transitionCount) ? Math.max(1, Math.floor(Number(row.transitionCount))) : 1,
            transitions:
              transitions.length > 0
                ? transitions
                : [{ seq: index + 1, at: updatedAt, fromState: null, toState: mappedState }]
          };
          if (String(row.state ?? "").trim().toUpperCase() === "FAILED") {
            normalized.blockedReasons = [
              ...normalized.blockedReasons,
              { code: "INVALID_TRANSITION", message: "migrated from legacy FAILED state to CANCELED" }
            ];
          }
          return normalized;
        })
    };
  }

  await ensureWorkflowRunRuntime(dataRoot, runId, runtime ?? buildInitialRuntimeFromTasks(normalizedTasks));
  if (runtime) {
    await writeWorkflowRunTaskRuntimeState(dataRoot, runId, runtime);
  }
  return {
    record,
    migrated:
      String(raw.schemaVersion ?? "") !== "2.0" ||
      Object.prototype.hasOwnProperty.call(raw, "workspaceBindingMode") ||
      Object.prototype.hasOwnProperty.call(raw, "boundProjectId") ||
      Object.prototype.hasOwnProperty.call(raw, "runtime"),
    runtime
  };
}

async function readTemplateRegistry(dataRoot: string): Promise<WorkflowTemplateRegistryState> {
  const paths = await ensureWorkflowRuntime(dataRoot);
  return repository.readJson(paths.templatesFile, defaultTemplateRegistry());
}

async function readRunRegistry(dataRoot: string): Promise<WorkflowRunRegistryState> {
  const paths = await ensureWorkflowRuntime(dataRoot);
  const raw = await repository.readJson(paths.runsFile, defaultRunRegistry() as WorkflowRunRegistryState | Record<string, unknown>);
  const maybeState = raw as WorkflowRunRegistryState;
  if (maybeState.schemaVersion === "2.0" && Array.isArray(maybeState.runs)) {
    const normalizedRuns: WorkflowRunRecord[] = [];
    let hasLegacyMigration = false;
    for (const item of maybeState.runs) {
      const normalized = await normalizeRunRecord(dataRoot, item as unknown as Record<string, unknown>);
      if (normalized.migrated) {
        hasLegacyMigration = true;
        await repository.deleteDirectory(path.join(paths.runsRootDir, normalized.record.runId));
        continue;
      }
      normalizedRuns.push(normalized.record);
    }
    if (hasLegacyMigration) {
      const next: WorkflowRunRegistryState = {
        schemaVersion: "2.0",
        updatedAt: new Date().toISOString(),
        runs: normalizedRuns
      };
      await repository.writeJson(paths.runsFile, next);
      return next;
    }
    return {
      schemaVersion: "2.0",
      updatedAt: typeof maybeState.updatedAt === "string" ? maybeState.updatedAt : new Date().toISOString(),
      runs: normalizedRuns
    };
  }

  await repository.deleteDirectory(paths.runsRootDir);
  await repository.ensureDirectory(paths.runsRootDir);
  const next: WorkflowRunRegistryState = defaultRunRegistry();
  await repository.writeJson(paths.runsFile, next);
  return next;
}

async function hydrateRunRuntime(dataRoot: string, run: WorkflowRunRecord): Promise<WorkflowRunRecord> {
  const runtime = await readWorkflowRunTaskRuntimeState(dataRoot, run.runId);
  return {
    ...run,
    runtime
  };
}

export async function listWorkflowTemplates(dataRoot: string): Promise<WorkflowTemplateRecord[]> {
  const state = await readTemplateRegistry(dataRoot);
  return [...state.templates].sort((a, b) => a.templateId.localeCompare(b.templateId));
}

export async function getWorkflowTemplate(dataRoot: string, templateIdRaw: string): Promise<WorkflowTemplateRecord | null> {
  const templateId = assertTemplateId(templateIdRaw);
  const state = await readTemplateRegistry(dataRoot);
  return state.templates.find((item) => item.templateId === templateId) ?? null;
}

export async function createWorkflowTemplate(
  dataRoot: string,
  input: CreateWorkflowTemplateInput
): Promise<WorkflowTemplateRecord> {
  return workflowWriteMutex.runExclusive(async () => {
    const templateId = assertTemplateId(input.templateId);
    const name = input.name.trim();
    if (!name) {
      throw new WorkflowStoreError("name is required", "INVALID_TEMPLATE");
    }
    const normalizedTasks = input.tasks.map((task, index) => normalizeTask(task, index));
    if (normalizedTasks.length === 0) {
      throw new WorkflowStoreError("at least one task is required", "INVALID_TEMPLATE");
    }
    const paths = await ensureWorkflowRuntime(dataRoot);
    const state = await readTemplateRegistry(dataRoot);
    if (state.templates.some((item) => item.templateId === templateId)) {
      throw new WorkflowStoreError(`template '${templateId}' already exists`, "TEMPLATE_EXISTS");
    }
    const now = new Date().toISOString();
    const created: WorkflowTemplateRecord = {
      schemaVersion: "1.0",
      templateId,
      name,
      description: input.description?.trim() || undefined,
      tasks: normalizedTasks,
      routeTable: normalizeRouteTable(input.routeTable),
      taskAssignRouteTable: normalizeRouteTable(input.taskAssignRouteTable),
      routeDiscussRounds: normalizeRouteDiscussRounds(input.routeDiscussRounds),
      defaultVariables: normalizeStringMap(input.defaultVariables),
      createdAt: now,
      updatedAt: now
    };
    state.templates.push(created);
    state.updatedAt = now;
    await repository.writeJson(paths.templatesFile, state);
    return created;
  });
}

export async function patchWorkflowTemplate(
  dataRoot: string,
  templateIdRaw: string,
  patch: PatchWorkflowTemplateInput
): Promise<WorkflowTemplateRecord> {
  return workflowWriteMutex.runExclusive(async () => {
    const templateId = assertTemplateId(templateIdRaw);
    const paths = await ensureWorkflowRuntime(dataRoot);
    const state = await readTemplateRegistry(dataRoot);
    const idx = state.templates.findIndex((item) => item.templateId === templateId);
    if (idx < 0) {
      throw new WorkflowStoreError(`template '${templateId}' not found`, "TEMPLATE_NOT_FOUND");
    }
    const existing = state.templates[idx];
    const now = new Date().toISOString();
    const next: WorkflowTemplateRecord = {
      ...existing,
      name: patch.name === undefined ? existing.name : patch.name.trim(),
      description:
        patch.description === undefined
          ? existing.description
          : patch.description === null
            ? undefined
            : patch.description.trim() || undefined,
      tasks: patch.tasks === undefined ? existing.tasks : patch.tasks.map((item, index) => normalizeTask(item, index)),
      routeTable: patch.routeTable === undefined ? existing.routeTable : normalizeRouteTable(patch.routeTable),
      taskAssignRouteTable:
        patch.taskAssignRouteTable === undefined
          ? existing.taskAssignRouteTable
          : normalizeRouteTable(patch.taskAssignRouteTable),
      routeDiscussRounds:
        patch.routeDiscussRounds === undefined
          ? existing.routeDiscussRounds
          : normalizeRouteDiscussRounds(patch.routeDiscussRounds),
      defaultVariables:
        patch.defaultVariables === undefined
          ? existing.defaultVariables
          : normalizeStringMap(patch.defaultVariables),
      updatedAt: now
    };
    if (!next.name) {
      throw new WorkflowStoreError("name is required", "INVALID_TEMPLATE");
    }
    if (!next.tasks || next.tasks.length === 0) {
      throw new WorkflowStoreError("at least one task is required", "INVALID_TEMPLATE");
    }
    state.templates[idx] = next;
    state.updatedAt = now;
    await repository.writeJson(paths.templatesFile, state);
    return next;
  });
}

export async function deleteWorkflowTemplate(
  dataRoot: string,
  templateIdRaw: string
): Promise<{ templateId: string; removedAt: string }> {
  return workflowWriteMutex.runExclusive(async () => {
    const templateId = assertTemplateId(templateIdRaw);
    const paths = await ensureWorkflowRuntime(dataRoot);
    const state = await readTemplateRegistry(dataRoot);
    const idx = state.templates.findIndex((item) => item.templateId === templateId);
    if (idx < 0) {
      throw new WorkflowStoreError(`template '${templateId}' not found`, "TEMPLATE_NOT_FOUND");
    }
    state.templates.splice(idx, 1);
    const removedAt = new Date().toISOString();
    state.updatedAt = removedAt;
    await repository.writeJson(paths.templatesFile, state);
    return { templateId, removedAt };
  });
}

export async function listWorkflowRuns(dataRoot: string): Promise<WorkflowRunRecord[]> {
  const state = await readRunRegistry(dataRoot);
  const sorted = [...state.runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const hydrated = await Promise.all(sorted.map((item) => hydrateRunRuntime(dataRoot, item)));
  return hydrated;
}

export async function getWorkflowRun(dataRoot: string, runIdRaw: string): Promise<WorkflowRunRecord | null> {
  const runId = assertRunId(runIdRaw);
  const state = await readRunRegistry(dataRoot);
  const found = state.runs.find((item) => item.runId === runId);
  if (!found) {
    return null;
  }
  return hydrateRunRuntime(dataRoot, found);
}

export async function createWorkflowRun(dataRoot: string, input: CreateWorkflowRunInput): Promise<WorkflowRunRecord> {
  const runId = assertRunId(input.runId);
  return await traceWorkflowPerfSpan(
    {
      dataRoot,
      runId,
      scope: "repo",
      name: "workflowRuns.createRun"
    },
    async () =>
      workflowWriteMutex.runExclusive(async () => {
    const templateId = assertTemplateId(input.templateId);
    const name = input.name.trim();
    const workspacePath = path.resolve(input.workspacePath);
    if (!name) {
      throw new WorkflowStoreError("run name is required", "INVALID_RUN");
    }
    if (!workspacePath) {
      throw new WorkflowStoreError("workspacePath is required", "INVALID_RUN");
    }
    const normalizedTasks = input.tasks.map((task, index) => normalizeRunTask(task, index));
    if (normalizedTasks.length === 0) {
      throw new WorkflowStoreError("run tasks must not be empty", "INVALID_RUN");
    }
    const paths = await ensureWorkflowRuntime(dataRoot);
    const state = await readRunRegistry(dataRoot);
    if (state.runs.some((item) => item.runId === runId)) {
      throw new WorkflowStoreError(`run '${runId}' already exists`, "RUN_EXISTS");
    }
    const mode = normalizeRunMode(input.mode) ?? "none";
    const loopEnabled = input.loopEnabled === undefined ? mode === "loop" : Boolean(input.loopEnabled);
    const scheduleEnabled = input.scheduleEnabled === undefined ? mode === "schedule" : Boolean(input.scheduleEnabled);
    const scheduleExpression = normalizeScheduleExpression(input.scheduleExpression);
    const isScheduleSeed =
      input.isScheduleSeed === undefined ? mode === "schedule" && scheduleEnabled : Boolean(input.isScheduleSeed);
    const autoDispatchRemaining = Number.isFinite(input.autoDispatchRemaining)
      ? Math.max(0, Math.floor(input.autoDispatchRemaining ?? 0))
      : 5;
    const autoDispatchInitialRemaining = Number.isFinite(input.autoDispatchInitialRemaining)
      ? Math.max(0, Math.floor(input.autoDispatchInitialRemaining ?? 0))
      : autoDispatchRemaining;
    const now = new Date().toISOString();
    const created: WorkflowRunRecord = {
      schemaVersion: "2.0",
      runId,
      templateId,
      name,
      description: input.description?.trim() || undefined,
      workspacePath,
      routeTable: normalizeRouteTable(input.routeTable),
      taskAssignRouteTable: normalizeRouteTable(input.taskAssignRouteTable),
      routeDiscussRounds: normalizeRouteDiscussRounds(input.routeDiscussRounds),
      variables: normalizeStringMap(input.variables),
      taskOverrides: normalizeStringMap(input.taskOverrides),
      tasks: normalizedTasks,
      status: "created",
      mode,
      loopEnabled,
      scheduleEnabled,
      scheduleExpression,
      isScheduleSeed,
      originRunId: normalizeMaybeRunId(input.originRunId),
      lastSpawnedRunId: normalizeMaybeRunId(input.lastSpawnedRunId),
      spawnState: normalizeSpawnState(input.spawnState),
      autoDispatchEnabled: input.autoDispatchEnabled === undefined ? true : Boolean(input.autoDispatchEnabled),
      autoDispatchRemaining,
      autoDispatchInitialRemaining,
      holdEnabled: Boolean(input.holdEnabled),
      reminderMode: input.reminderMode === "fixed_interval" ? "fixed_interval" : "backoff",
      createdAt: now,
      updatedAt: now,
      roleSessionMap: normalizeRoleSessionMap(input.roleSessionMap)
    };
    state.runs.push(created);
    state.updatedAt = now;
    await repository.writeJson(paths.runsFile, state);
    await ensureWorkflowRunRuntime(dataRoot, runId, buildInitialRuntimeFromTasks(normalizedTasks));
    return hydrateRunRuntime(dataRoot, created);
      })
  );
}

export async function patchWorkflowRun(
  dataRoot: string,
  runIdRaw: string,
  patch: PatchWorkflowRunInput
): Promise<WorkflowRunRecord> {
  const runId = assertRunId(runIdRaw);
  return await traceWorkflowPerfSpan(
    {
      dataRoot,
      runId,
      scope: "repo",
      name: "workflowRuns.patchRun"
    },
    async () =>
      workflowWriteMutex.runExclusive(async () => {
    const paths = await ensureWorkflowRuntime(dataRoot);
    const state = await readRunRegistry(dataRoot);
    const idx = state.runs.findIndex((item) => item.runId === runId);
    if (idx < 0) {
      throw new WorkflowStoreError(`run '${runId}' not found`, "RUN_NOT_FOUND");
    }
    const existing = state.runs[idx];
    const now = new Date().toISOString();
    const next: WorkflowRunRecord = {
      ...existing,
      status: patch.status ?? existing.status,
      lastHeartbeatAt:
        patch.lastHeartbeatAt === undefined
          ? existing.lastHeartbeatAt
          : patch.lastHeartbeatAt === null
            ? undefined
            : patch.lastHeartbeatAt,
      startedAt:
        patch.startedAt === undefined ? existing.startedAt : patch.startedAt === null ? undefined : patch.startedAt,
      stoppedAt:
        patch.stoppedAt === undefined ? existing.stoppedAt : patch.stoppedAt === null ? undefined : patch.stoppedAt,
      description:
        patch.description === undefined
          ? existing.description
          : patch.description === null
            ? undefined
            : patch.description.trim() || undefined,
      tasks: patch.tasks === undefined ? existing.tasks : patch.tasks.map((item, index) => normalizeRunTask(item, index)),
      mode:
        patch.mode === undefined
          ? existing.mode
          : normalizeRunMode(patch.mode) ?? existing.mode ?? "none",
      loopEnabled: patch.loopEnabled === undefined ? existing.loopEnabled : Boolean(patch.loopEnabled),
      scheduleEnabled:
        patch.scheduleEnabled === undefined ? existing.scheduleEnabled : Boolean(patch.scheduleEnabled),
      scheduleExpression:
        patch.scheduleExpression === undefined
          ? existing.scheduleExpression
          : patch.scheduleExpression === null
            ? undefined
            : normalizeScheduleExpression(patch.scheduleExpression),
      isScheduleSeed:
        patch.isScheduleSeed === undefined ? existing.isScheduleSeed : Boolean(patch.isScheduleSeed),
      originRunId:
        patch.originRunId === undefined
          ? existing.originRunId
          : patch.originRunId === null
            ? undefined
            : normalizeMaybeRunId(patch.originRunId),
      lastSpawnedRunId:
        patch.lastSpawnedRunId === undefined
          ? existing.lastSpawnedRunId
          : patch.lastSpawnedRunId === null
            ? undefined
            : normalizeMaybeRunId(patch.lastSpawnedRunId),
      spawnState:
        patch.spawnState === undefined
          ? existing.spawnState
          : patch.spawnState === null
            ? undefined
            : normalizeSpawnState(patch.spawnState),
      autoDispatchEnabled:
        patch.autoDispatchEnabled === undefined ? existing.autoDispatchEnabled : Boolean(patch.autoDispatchEnabled),
      autoDispatchRemaining:
        patch.autoDispatchRemaining === undefined
          ? existing.autoDispatchRemaining
          : Number.isFinite(patch.autoDispatchRemaining)
            ? Math.max(0, Math.floor(patch.autoDispatchRemaining))
            : existing.autoDispatchRemaining,
      autoDispatchInitialRemaining:
        patch.autoDispatchInitialRemaining === undefined
          ? existing.autoDispatchInitialRemaining
          : Number.isFinite(patch.autoDispatchInitialRemaining)
            ? Math.max(0, Math.floor(patch.autoDispatchInitialRemaining))
            : existing.autoDispatchInitialRemaining,
      holdEnabled: patch.holdEnabled === undefined ? existing.holdEnabled : Boolean(patch.holdEnabled),
      reminderMode:
        patch.reminderMode === undefined
          ? existing.reminderMode
          : patch.reminderMode === "fixed_interval"
            ? "fixed_interval"
            : "backoff",
      roleSessionMap:
        patch.roleSessionMap === undefined
          ? existing.roleSessionMap
          : normalizeRoleSessionMap(patch.roleSessionMap),
      updatedAt: now
    };
    state.runs[idx] = next;
    state.updatedAt = now;
    await repository.writeJson(paths.runsFile, state);
    if (patch.runtime !== undefined) {
      if (patch.runtime === null) {
        await writeWorkflowRunTaskRuntimeState(dataRoot, runId, buildInitialRuntimeFromTasks(next.tasks));
      } else {
        await writeWorkflowRunTaskRuntimeState(dataRoot, runId, patch.runtime);
      }
    }
    return hydrateRunRuntime(dataRoot, next);
      })
  );
}

export async function deleteWorkflowRun(
  dataRoot: string,
  runIdRaw: string
): Promise<{ runId: string; removedAt: string }> {
  return workflowWriteMutex.runExclusive(async () => {
    const runId = assertRunId(runIdRaw);
    const paths = await ensureWorkflowRuntime(dataRoot);
    const state = await readRunRegistry(dataRoot);
    const idx = state.runs.findIndex((item) => item.runId === runId);
    if (idx < 0) {
      throw new WorkflowStoreError(`run '${runId}' not found`, "RUN_NOT_FOUND");
    }
    state.runs.splice(idx, 1);
    const removedAt = new Date().toISOString();
    state.updatedAt = removedAt;
    const runtimeDir = path.join(paths.runsRootDir, runId);
    await unitOfWork.run([paths.workflowsRootDir, runtimeDir], async () => {
      await repository.writeJson(paths.runsFile, state);
      await repository.deleteDirectory(runtimeDir);
    });
    return { runId, removedAt };
  });
}

export interface WorkflowRunRepository {
  listTemplates(): Promise<WorkflowTemplateRecord[]>;
  getTemplate(templateId: string): Promise<WorkflowTemplateRecord | null>;
  createTemplate(input: CreateWorkflowTemplateInput): Promise<WorkflowTemplateRecord>;
  patchTemplate(templateId: string, patch: PatchWorkflowTemplateInput): Promise<WorkflowTemplateRecord>;
  deleteTemplate(templateId: string): Promise<{ templateId: string; removedAt: string }>;
  listRuns(): Promise<WorkflowRunRecord[]>;
  getRun(runId: string): Promise<WorkflowRunRecord | null>;
  createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunRecord>;
  patchRun(runId: string, patch: PatchWorkflowRunInput): Promise<WorkflowRunRecord>;
  deleteRun(runId: string): Promise<{ runId: string; removedAt: string }>;
  ensureRuntime(runId: string, initialRuntime?: WorkflowRunRuntimeState): Promise<void>;
  readRuntime(runId: string): Promise<WorkflowRunRuntimeState>;
  writeRuntime(runId: string, runtime: WorkflowRunRuntimeState): Promise<void>;
}

class DefaultWorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly dataRoot: string) {}

  listTemplates(): Promise<WorkflowTemplateRecord[]> {
    return listWorkflowTemplates(this.dataRoot);
  }

  getTemplate(templateId: string): Promise<WorkflowTemplateRecord | null> {
    return getWorkflowTemplate(this.dataRoot, templateId);
  }

  createTemplate(input: CreateWorkflowTemplateInput): Promise<WorkflowTemplateRecord> {
    return createWorkflowTemplate(this.dataRoot, input);
  }

  patchTemplate(templateId: string, patch: PatchWorkflowTemplateInput): Promise<WorkflowTemplateRecord> {
    return patchWorkflowTemplate(this.dataRoot, templateId, patch);
  }

  deleteTemplate(templateId: string): Promise<{ templateId: string; removedAt: string }> {
    return deleteWorkflowTemplate(this.dataRoot, templateId);
  }

  listRuns(): Promise<WorkflowRunRecord[]> {
    return listWorkflowRuns(this.dataRoot);
  }

  getRun(runId: string): Promise<WorkflowRunRecord | null> {
    return getWorkflowRun(this.dataRoot, runId);
  }

  createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunRecord> {
    return createWorkflowRun(this.dataRoot, input);
  }

  patchRun(runId: string, patch: PatchWorkflowRunInput): Promise<WorkflowRunRecord> {
    return patchWorkflowRun(this.dataRoot, runId, patch);
  }

  deleteRun(runId: string): Promise<{ runId: string; removedAt: string }> {
    return deleteWorkflowRun(this.dataRoot, runId);
  }

  async ensureRuntime(runId: string, initialRuntime?: WorkflowRunRuntimeState): Promise<void> {
    await ensureWorkflowRunRuntime(this.dataRoot, runId, initialRuntime);
  }

  readRuntime(runId: string): Promise<WorkflowRunRuntimeState> {
    return readWorkflowRunTaskRuntimeState(this.dataRoot, runId);
  }

  writeRuntime(runId: string, runtime: WorkflowRunRuntimeState): Promise<void> {
    return writeWorkflowRunTaskRuntimeState(this.dataRoot, runId, runtime);
  }
}

export function createWorkflowRunRepository(dataRoot: string): WorkflowRunRepository {
  return new DefaultWorkflowRunRepository(dataRoot);
}
