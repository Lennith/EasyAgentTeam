import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { listAgents } from "../data/agent-store.js";
import { resolveImportedSkillPromptSegments, resolveSkillIdsForAgent } from "../data/skill-store.js";
import { getRuntimeSettings } from "../data/runtime-settings-store.js";
import {
  appendWorkflowInboxMessage,
  appendWorkflowRunEvent,
  getWorkflowSession,
  listWorkflowInboxMessages,
  listWorkflowRunEvents,
  listWorkflowSessions,
  readWorkflowRunTaskRuntimeState,
  removeWorkflowInboxMessages,
  touchWorkflowSession,
  upsertWorkflowSession,
  writeWorkflowRunTaskRuntimeState
} from "../data/workflow-run-store.js";
import { getWorkflowRoleReminderState, updateWorkflowRoleReminderState } from "../data/workflow-role-reminder-store.js";
import { getWorkflowRun, listWorkflowRuns, patchWorkflowRun, WorkflowStoreError } from "../data/workflow-store.js";
import type {
  ProjectRecord,
  WorkflowBlockReasonCode,
  WorkflowManagerToAgentMessage,
  ReminderMode,
  WorkflowRunRecord,
  WorkflowRunEventRecord,
  WorkflowRunRuntimeSnapshot,
  WorkflowRunRuntimeState,
  WorkflowRunState,
  WorkflowSessionRecord,
  WorkflowTaskActionRequest,
  WorkflowTaskActionResult,
  WorkflowTaskRuntimeRecord,
  WorkflowTaskState
} from "../domain/models.js";
import { logger } from "../utils/logger.js";
import { buildDefaultRolePrompt, ensureAgentWorkspaces } from "./agent-workspace-service.js";
import {
  extractTaskIdFromMessage,
  isRemindableTaskState,
  readMessageTypeUpper,
  selectTaskForDispatch,
  sortMessagesByTime
} from "./orchestrator-dispatch-core.js";
import {
  buildOrchestratorContextSessionKey,
  OrchestratorLoopCore,
  runOrchestratorAdapterTick
} from "./orchestrator-core.js";
import { buildReminderMessageBody } from "./reminder-message-builder.js";
import { getTimeoutCooldownMs, getTimeoutEscalationThreshold } from "./session-lifecycle-authority.js";
import { dumpSessionMessagesOnSoftTimeout } from "./session-timeout-message-dump.js";
import { createProviderRegistry, resolveSessionProviderId } from "./provider-runtime.js";
import { createWorkflowToolExecutionAdapter, DefaultToolInjector } from "./tool-injector.js";
import { resolveWorkflowRunRoleScope } from "./workflow-role-scope-service.js";

export interface WorkflowRunRuntimeStatus {
  runId: string;
  status: WorkflowRunState;
  active: boolean;
  startedAt?: string;
  stoppedAt?: string;
  lastHeartbeatAt?: string;
}

export interface WorkflowOrchestratorStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  maxConcurrentDispatches: number;
  inFlightDispatchSessions: number;
  lastTickAt: string | null;
  started: boolean;
  activeRunIds: string[];
  activeRunCount: number;
  runs?: Array<{
    runId: string;
    autoDispatchEnabled: boolean;
    autoDispatchRemaining: number;
    holdEnabled: boolean;
    reminderMode: ReminderMode;
  }>;
}

export interface WorkflowTaskTreeRuntimeResponse {
  run_id: string;
  generated_at: string;
  status: WorkflowRunState;
  active: boolean;
  roots: string[];
  nodes: Array<{
    taskId: string;
    title: string;
    resolvedTitle: string;
    ownerRole: string;
    parentTaskId?: string;
    dependencies?: string[];
    writeSet?: string[];
    acceptance?: string[];
    artifacts?: string[];
    creatorRole?: string;
    creatorSessionId?: string;
    runtime: WorkflowTaskRuntimeRecord | null;
  }>;
  edges: Array<{ from_task_id: string; to_task_id: string; relation: "PARENT_CHILD" | "DEPENDS_ON" }>;
  counters: WorkflowRunRuntimeSnapshot["counters"];
}

export interface WorkflowRunOrchestratorSettings {
  run_id: string;
  auto_dispatch_enabled: boolean;
  auto_dispatch_remaining: number;
  hold_enabled: boolean;
  reminder_mode: ReminderMode;
  updated_at: string;
}

export interface WorkflowDispatchResult {
  runId: string;
  results: Array<{
    role: string;
    sessionId: string | null;
    taskId: string | null;
    dispatchKind?: "task" | "message" | null;
    messageId?: string;
    requestId?: string;
    outcome: "dispatched" | "no_task" | "session_busy" | "run_not_running" | "invalid_target" | "already_dispatched";
    reason?: string;
  }>;
  dispatchedCount: number;
  remainingBudget: number;
}

export class WorkflowRuntimeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | WorkflowBlockReasonCode
      | "ROUTE_DENIED"
      | "MESSAGE_TARGET_REQUIRED"
      | "TASK_OWNER_ROLE_NOT_FOUND"
      | "TASK_DEPENDENCY_NOT_READY",
    public readonly status: number = 400,
    public readonly hint?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

interface WorkflowOrchestratorOptions {
  enabled?: boolean;
  intervalMs?: number;
  maxConcurrentDispatches?: number;
  idleReminderMs?: number;
  reminderBackoffMultiplier?: number;
  reminderMaxIntervalMs?: number;
  reminderMaxCount?: number;
  autoReminderEnabled?: boolean;
  sessionRunningTimeoutMs?: number;
}

const TERMINAL_STATES = new Set<WorkflowTaskState>(["DONE", "CANCELED"]);
const ACTIVE_STATES = new Set<WorkflowTaskState>(["DISPATCHED", "IN_PROGRESS", "MAY_BE_DONE"]);
const REPORTABLE_STATES = new Set<WorkflowTaskState>([
  "PLANNED",
  "READY",
  "DISPATCHED",
  "IN_PROGRESS",
  "BLOCKED_DEP",
  "MAY_BE_DONE"
]);
const MAY_BE_DONE_DISPATCH_THRESHOLD = 5;
const MAY_BE_DONE_CHECK_WINDOW_MS = 60 * 60 * 1000;
const AUTO_FINISH_STABLE_TICKS_REQUIRED = 2;
const providerRegistry = createProviderRegistry();

function isTerminalState(state: WorkflowTaskState): boolean {
  return TERMINAL_STATES.has(state);
}

function buildSessionId(role: string): string {
  const safeRole = role.replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `session-${safeRole}-${randomUUID().slice(0, 12)}`;
}

function buildRolePromptMapForRoles(agents: Array<{ agentId: string; prompt: string }>): Map<string, string> {
  return new Map(agents.map((agent) => [agent.agentId, agent.prompt]));
}

function hasRoutePermission(run: WorkflowRunRecord, fromAgent: string, toRole: string): boolean {
  const table = run.routeTable;
  if (!table || Object.keys(table).length === 0) {
    return true;
  }
  return Array.isArray(table[fromAgent]) && table[fromAgent].includes(toRole);
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function mergeDependencies(parentDependencies: string[], explicitDependencies: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const dep of [...parentDependencies, ...explicitDependencies]) {
    const normalized = dep.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged;
}

function findLatestOpenDispatch(
  sessionEvents: WorkflowRunEventRecord[]
): { event: WorkflowRunEventRecord; dispatchId: string } | null {
  const started = new Map<string, WorkflowRunEventRecord>();
  for (const event of sessionEvents) {
    const payload = event.payload as Record<string, unknown>;
    const dispatchId = readPayloadString(payload, "dispatchId");
    if (!dispatchId) {
      continue;
    }
    if (event.eventType === "ORCHESTRATOR_DISPATCH_STARTED") {
      started.set(dispatchId, event);
      continue;
    }
    if (event.eventType === "ORCHESTRATOR_DISPATCH_FINISHED" || event.eventType === "ORCHESTRATOR_DISPATCH_FAILED") {
      started.delete(dispatchId);
    }
  }
  if (started.size === 0) {
    return null;
  }
  const latest = [...started.entries()].sort((a, b) => Date.parse(b[1].createdAt) - Date.parse(a[1].createdAt))[0];
  return {
    dispatchId: latest[0],
    event: latest[1]
  };
}

function hasOpenTaskDispatch(events: WorkflowRunEventRecord[], taskId: string, sessionId: string): boolean {
  const started = new Set<string>();
  for (const event of events) {
    if (event.taskId !== taskId || event.sessionId !== sessionId) {
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    const dispatchId = readPayloadString(payload, "dispatchId");
    const dispatchKind = readPayloadString(payload, "dispatchKind");
    if (!dispatchId || dispatchKind !== "task") {
      continue;
    }
    if (event.eventType === "ORCHESTRATOR_DISPATCH_STARTED") {
      started.add(dispatchId);
      continue;
    }
    if (event.eventType === "ORCHESTRATOR_DISPATCH_FINISHED" || event.eventType === "ORCHESTRATOR_DISPATCH_FAILED") {
      started.delete(dispatchId);
    }
  }
  return started.size > 0;
}

function createInitialRuntime(run: WorkflowRunRecord): WorkflowRunRuntimeState {
  const now = new Date().toISOString();
  return {
    initializedAt: now,
    updatedAt: now,
    transitionSeq: run.tasks.length,
    tasks: run.tasks.map((task, index) => ({
      taskId: task.taskId,
      state: "PLANNED",
      blockedBy: [],
      blockedReasons: [],
      lastTransitionAt: now,
      transitionCount: 1,
      transitions: [{ seq: index + 1, at: now, fromState: null, toState: "PLANNED" }]
    }))
  };
}

function computeCounters(tasks: WorkflowTaskRuntimeRecord[]): WorkflowRunRuntimeSnapshot["counters"] {
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

function isRuntimeTerminal(runtime: WorkflowRunRuntimeState): boolean {
  return runtime.tasks.length > 0 && runtime.tasks.every((task) => isTerminalState(task.state));
}

function parseIsoMs(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeReminderMode(raw: ReminderMode | undefined): ReminderMode {
  return raw === "fixed_interval" ? "fixed_interval" : "backoff";
}

function calculateNextReminderTimeByMode(
  reminderMode: ReminderMode,
  reminderCount: number,
  nowMs: number,
  options: { initialWaitMs: number; backoffMultiplier: number; maxWaitMs: number }
): string {
  if (reminderMode === "fixed_interval") {
    return new Date(nowMs + options.initialWaitMs).toISOString();
  }
  const waitMs = Math.min(
    options.initialWaitMs * Math.pow(options.backoffMultiplier, reminderCount),
    options.maxWaitMs
  );
  return new Date(nowMs + waitMs).toISOString();
}

function getRoleState(session: WorkflowSessionRecord | null): "INACTIVE" | "IDLE" | "RUNNING" {
  if (!session) {
    return "INACTIVE";
  }
  if (session.status === "running") {
    return "RUNNING";
  }
  if (session.status === "idle") {
    return "IDLE";
  }
  return "INACTIVE";
}

function shouldAutoResetReminderOnRoleTransition(
  previousState: "INACTIVE" | "IDLE" | "RUNNING",
  currentState: "INACTIVE" | "IDLE" | "RUNNING"
): boolean {
  return previousState === "INACTIVE" && currentState === "IDLE";
}

export class WorkflowOrchestratorService {
  private readonly loopCore: OrchestratorLoopCore;
  private readonly activeRunIds = new Set<string>();
  private readonly inFlightDispatchSessionKeys = new Set<string>();
  private readonly runHoldState = new Map<string, boolean>();
  private readonly runAutoFinishStableTicks = new Map<string, number>();
  private readonly sessionHeartbeatThrottle = new Map<string, number>();

  constructor(
    private readonly dataRoot: string,
    private readonly options: Required<WorkflowOrchestratorOptions>
  ) {
    this.loopCore = new OrchestratorLoopCore({
      enabled: this.options.enabled,
      intervalMs: this.options.intervalMs,
      onTick: async () => {
        await this.tickLoop();
      },
      onError: (error) => {
        logger.error(
          `[workflow-orchestrator] tickLoop failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  start(): void {
    this.loopCore.start();
  }

  stop(): void {
    this.loopCore.stop();
    this.activeRunIds.clear();
    this.inFlightDispatchSessionKeys.clear();
    this.runHoldState.clear();
    this.runAutoFinishStableTicks.clear();
    this.sessionHeartbeatThrottle.clear();
  }

  private buildRunRoleKey(runId: string, role: string): string {
    return buildOrchestratorContextSessionKey(runId, role);
  }

  private buildRunSessionKey(runId: string, sessionId: string): string {
    return buildOrchestratorContextSessionKey(runId, sessionId);
  }

  private extractRunIdFromScopedKey(key: string): string {
    const separator = key.indexOf("::");
    if (separator <= 0) {
      return "";
    }
    return key.slice(0, separator);
  }

  private clearRunScopedState(runId: string): void {
    this.runHoldState.delete(runId);
    this.runAutoFinishStableTicks.delete(runId);
    for (const key of Array.from(this.sessionHeartbeatThrottle.keys())) {
      if (this.extractRunIdFromScopedKey(key) === runId) {
        this.sessionHeartbeatThrottle.delete(key);
      }
    }
    for (const key of Array.from(this.inFlightDispatchSessionKeys)) {
      if (this.extractRunIdFromScopedKey(key) === runId) {
        this.inFlightDispatchSessionKeys.delete(key);
      }
    }
  }

  private pruneInactiveRunScopedState(activeRunIds: Set<string>): void {
    for (const runId of Array.from(this.runHoldState.keys())) {
      if (!activeRunIds.has(runId)) {
        this.runHoldState.delete(runId);
      }
    }
    for (const runId of Array.from(this.runAutoFinishStableTicks.keys())) {
      if (!activeRunIds.has(runId)) {
        this.runAutoFinishStableTicks.delete(runId);
      }
    }
    for (const key of Array.from(this.sessionHeartbeatThrottle.keys())) {
      const runId = this.extractRunIdFromScopedKey(key);
      if (!runId || !activeRunIds.has(runId)) {
        this.sessionHeartbeatThrottle.delete(key);
      }
    }
    for (const key of Array.from(this.inFlightDispatchSessionKeys)) {
      const runId = this.extractRunIdFromScopedKey(key);
      if (!runId || !activeRunIds.has(runId)) {
        this.inFlightDispatchSessionKeys.delete(key);
      }
    }
  }

  private async loadRunOrThrow(runId: string): Promise<WorkflowRunRecord> {
    const run = await getWorkflowRun(this.dataRoot, runId);
    if (!run) {
      throw new WorkflowStoreError(`run '${runId}' not found`, "RUN_NOT_FOUND");
    }
    return run;
  }

  private addTransition(
    runtime: WorkflowRunRuntimeState,
    task: WorkflowTaskRuntimeRecord,
    toState: WorkflowTaskState,
    summary?: string
  ): void {
    const now = new Date().toISOString();
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

  private collectUnsatisfiedDependencies(
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
      if (!depTask || depTask.state !== "DONE") {
        unresolved.push(dep);
      }
    }
    return unresolved;
  }

  private reevaluateDependencyGate(run: WorkflowRunRecord, runtime: WorkflowRunRuntimeState): void {
    const byId = new Map(runtime.tasks.map((task) => [task.taskId, task]));
    for (const taskDef of run.tasks) {
      const runtimeTask = byId.get(taskDef.taskId);
      if (!runtimeTask) continue;
      if (isTerminalState(runtimeTask.state) || ACTIVE_STATES.has(runtimeTask.state)) continue;
      const unresolved = this.collectUnsatisfiedDependencies(run, byId, taskDef.taskId);
      if (unresolved.length > 0) {
        runtimeTask.blockedBy = unresolved;
        runtimeTask.blockers = unresolved;
        runtimeTask.blockedReasons = [{ code: "DEP_UNSATISFIED", dependencyTaskIds: unresolved }];
        if (runtimeTask.state !== "BLOCKED_DEP") {
          this.addTransition(runtime, runtimeTask, "BLOCKED_DEP");
        }
      } else {
        runtimeTask.blockedBy = [];
        runtimeTask.blockers = undefined;
        runtimeTask.blockedReasons = [];
        if (runtimeTask.state !== "READY") {
          this.addTransition(runtime, runtimeTask, "READY");
        }
      }
    }
  }

  private recomputeParentTaskStates(run: WorkflowRunRecord, runtime: WorkflowRunRuntimeState): void {
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
    const depthVisiting = new Set<string>();
    const resolveDepth = (taskId: string): number => {
      const cached = depthCache.get(taskId);
      if (cached !== undefined) {
        return cached;
      }
      if (depthVisiting.has(taskId)) {
        return 0;
      }
      depthVisiting.add(taskId);
      const task = taskById.get(taskId);
      const parent = task?.parentTaskId?.trim();
      const depth = !parent || parent === taskId || !taskById.has(parent) ? 0 : resolveDepth(parent) + 1;
      depthVisiting.delete(taskId);
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

      const unresolved = this.collectUnsatisfiedDependencies(run, runtimeById, parentTaskId);
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
        this.addTransition(runtime, parentRuntime, nextState);
      }
    }
  }

  private async ensureRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState> {
    const runtime = run.runtime ?? (await readWorkflowRunTaskRuntimeState(this.dataRoot, run.runId));
    const normalized = runtime?.tasks ? runtime : createInitialRuntime(run);
    const existingByTask = new Map(normalized.tasks.map((item) => [item.taskId, item]));
    const nextTasks: WorkflowTaskRuntimeRecord[] = [];
    let changed = false;
    for (const taskDef of run.tasks) {
      const found = existingByTask.get(taskDef.taskId);
      if (found) {
        nextTasks.push(found);
      } else {
        changed = true;
        nextTasks.push({
          taskId: taskDef.taskId,
          state: "PLANNED",
          blockedBy: [],
          blockedReasons: [],
          lastTransitionAt: new Date().toISOString(),
          transitionCount: 1,
          transitions: [
            { seq: normalized.transitionSeq + 1, at: new Date().toISOString(), fromState: null, toState: "PLANNED" }
          ]
        });
      }
    }
    if (nextTasks.length !== normalized.tasks.length) {
      changed = true;
    }
    const nextRuntime: WorkflowRunRuntimeState = { ...normalized, tasks: nextTasks };
    this.reevaluateDependencyGate(run, nextRuntime);
    this.recomputeParentTaskStates(run, nextRuntime);
    if (changed) {
      await writeWorkflowRunTaskRuntimeState(this.dataRoot, run.runId, nextRuntime);
      await patchWorkflowRun(this.dataRoot, run.runId, { runtime: nextRuntime });
    }
    return nextRuntime;
  }

  private toSnapshot(run: WorkflowRunRecord, runtime: WorkflowRunRuntimeState): WorkflowRunRuntimeSnapshot {
    const active = run.status === "running" && this.activeRunIds.has(run.runId);
    return {
      runId: run.runId,
      status: run.status,
      active,
      updatedAt: runtime.updatedAt,
      counters: computeCounters(runtime.tasks),
      tasks: runtime.tasks
    };
  }

  private async persistRoleSessionMap(
    run: WorkflowRunRecord,
    role: string,
    sessionId: string | null
  ): Promise<boolean> {
    const normalizedRole = role.trim();
    if (!normalizedRole) {
      return false;
    }
    const current = run.roleSessionMap?.[normalizedRole];
    if ((sessionId ?? undefined) === current) {
      return false;
    }
    const nextMap = { ...(run.roleSessionMap ?? {}) };
    if (sessionId) {
      nextMap[normalizedRole] = sessionId;
    } else {
      delete nextMap[normalizedRole];
    }
    const normalized = Object.keys(nextMap).length > 0 ? nextMap : undefined;
    await patchWorkflowRun(this.dataRoot, run.runId, { roleSessionMap: normalized ?? {} });
    run.roleSessionMap = normalized;
    return true;
  }

  private async resolveAuthoritativeSession(
    runId: string,
    role: string,
    sessions: WorkflowSessionRecord[],
    runRecord?: WorkflowRunRecord,
    reason: string = "workflow_runtime"
  ): Promise<WorkflowSessionRecord | null> {
    const normalizedRole = role.trim();
    if (!normalizedRole) {
      return null;
    }
    const run = runRecord ?? (await this.loadRunOrThrow(runId));
    const roleSessions = [...sessions].filter((item) => item.role === normalizedRole && item.status !== "dismissed");
    const mappedSessionId = run.roleSessionMap?.[normalizedRole];
    if (roleSessions.length === 0) {
      if (mappedSessionId) {
        await this.persistRoleSessionMap(run, normalizedRole, null);
      }
      const created = await upsertWorkflowSession(this.dataRoot, runId, {
        sessionId: buildSessionId(normalizedRole),
        role: normalizedRole,
        status: "idle",
        provider: "minimax"
      });
      sessions.push(created.session);
      await this.persistRoleSessionMap(run, normalizedRole, created.session.sessionId);
      return created.session;
    }

    const activeRunners = roleSessions
      .filter((item) => {
        if (item.status !== "running") {
          return false;
        }
        const providerSessionId = item.providerSessionId?.trim() || item.sessionId;
        return providerRegistry.isSessionActive(item.provider, providerSessionId);
      })
      .sort((a, b) => {
        const aRecent = Math.max(parseIsoMs(a.lastActiveAt), parseIsoMs(a.updatedAt), parseIsoMs(a.createdAt));
        const bRecent = Math.max(parseIsoMs(b.lastActiveAt), parseIsoMs(b.updatedAt), parseIsoMs(b.createdAt));
        if (aRecent !== bRecent) {
          return bRecent - aRecent;
        }
        return a.sessionId.localeCompare(b.sessionId);
      });
    const mapped =
      mappedSessionId && roleSessions.some((item) => item.sessionId === mappedSessionId)
        ? (roleSessions.find((item) => item.sessionId === mappedSessionId) ?? null)
        : null;
    const winner =
      activeRunners[0] ??
      mapped ??
      roleSessions.sort((a, b) => {
        const aRecent = Math.max(parseIsoMs(a.lastActiveAt), parseIsoMs(a.updatedAt), parseIsoMs(a.createdAt));
        const bRecent = Math.max(parseIsoMs(b.lastActiveAt), parseIsoMs(b.updatedAt), parseIsoMs(b.createdAt));
        if (aRecent !== bRecent) {
          return bRecent - aRecent;
        }
        return a.sessionId.localeCompare(b.sessionId);
      })[0];
    const losers = roleSessions.filter((item) => item.sessionId !== winner.sessionId);
    const mapUpdated = await this.persistRoleSessionMap(run, normalizedRole, winner.sessionId);

    if (losers.length > 0) {
      await appendWorkflowRunEvent(this.dataRoot, runId, {
        eventType: "ROLE_SESSION_CONFLICT_DETECTED",
        source: "system",
        sessionId: winner.sessionId,
        payload: {
          role: normalizedRole,
          reason,
          winnerSessionId: winner.sessionId,
          loserSessionIds: losers.map((item) => item.sessionId)
        }
      });
      for (const loser of losers) {
        await touchWorkflowSession(this.dataRoot, runId, loser.sessionId, {
          status: "dismissed",
          currentTaskId: null,
          agentPid: null
        }).catch(() => {});
        loser.status = "dismissed";
        await appendWorkflowRunEvent(this.dataRoot, runId, {
          eventType: "DISPATCH_CLOSED_BY_CONFLICT",
          source: "system",
          sessionId: loser.sessionId,
          taskId: loser.currentTaskId,
          payload: {
            role: normalizedRole,
            winnerSessionId: winner.sessionId,
            loserSessionId: loser.sessionId,
            dispatchId: loser.lastDispatchId ?? null,
            runId
          }
        });
      }
    }
    if (losers.length > 0 || mapUpdated) {
      await appendWorkflowRunEvent(this.dataRoot, runId, {
        eventType: "ROLE_SESSION_CONFLICT_RESOLVED",
        source: "system",
        sessionId: winner.sessionId,
        payload: {
          role: normalizedRole,
          reason,
          activeSessionId: winner.sessionId,
          dismissedSessionIds: losers.map((item) => item.sessionId),
          roleSessionMapUpdated: mapUpdated
        }
      });
    }
    return (await getWorkflowSession(this.dataRoot, runId, winner.sessionId)) ?? winner;
  }

  private async touchSessionHeartbeat(runId: string, sessionId: string): Promise<void> {
    const key = this.buildRunSessionKey(runId, sessionId);
    const nowMs = Date.now();
    const last = this.sessionHeartbeatThrottle.get(key) ?? 0;
    if (nowMs - last < 1000) {
      return;
    }
    this.sessionHeartbeatThrottle.set(key, nowMs);
    // Heartbeat updates activity timestamp only; status transitions are controlled by dispatch/timeout handlers.
    await touchWorkflowSession(this.dataRoot, runId, sessionId, {}).catch(() => {});
  }

  private buildDispatchPrompt(input: {
    run: WorkflowRunRecord;
    role: string;
    taskId: string | null;
    dispatchKind: "task" | "message";
    message: WorkflowManagerToAgentMessage | null;
    taskState: WorkflowTaskState | null;
    runtimeTasks: WorkflowTaskRuntimeRecord[];
    rolePrompt?: string;
  }): string {
    const messageType = input.message ? readMessageTypeUpper(input.message) : "TASK_ASSIGNMENT";
    const messageContent =
      input.message && typeof (input.message.body as Record<string, unknown>).content === "string"
        ? String((input.message.body as Record<string, unknown>).content)
        : "";
    const task = input.taskId ? input.run.tasks.find((item) => item.taskId === input.taskId) : null;
    const runtimeById = new Map(input.runtimeTasks.map((item) => [item.taskId, item]));
    const runTaskById = new Map(input.run.tasks.map((item) => [item.taskId, item]));
    const focusDependencyIds = task?.dependencies ?? [];
    const unresolvedFocusDependencies = focusDependencyIds.filter((depId) => {
      const depRuntime = runtimeById.get(depId);
      return !depRuntime || (depRuntime.state !== "DONE" && depRuntime.state !== "CANCELED");
    });
    const dependencyStatus =
      focusDependencyIds.length > 0
        ? focusDependencyIds.map((depId) => `${depId}=${runtimeById.get(depId)?.state ?? "UNKNOWN"}`).join(", ")
        : "(none)";
    const visibleRoleTasks = input.runtimeTasks
      .map((runtimeTask) => ({ runtimeTask, def: runTaskById.get(runtimeTask.taskId) }))
      .filter((item) => item.def?.ownerRole === input.role);
    const visibleActionableTasks = visibleRoleTasks
      .filter(
        (item) =>
          item.runtimeTask.state === "READY" ||
          item.runtimeTask.state === "DISPATCHED" ||
          item.runtimeTask.state === "IN_PROGRESS" ||
          item.runtimeTask.state === "MAY_BE_DONE"
      )
      .map((item) => `${item.runtimeTask.taskId}(${item.runtimeTask.state})`);
    const visibleBlockedTasks = visibleRoleTasks
      .filter((item) => item.runtimeTask.state === "BLOCKED_DEP")
      .map(
        (item) => `${item.runtimeTask.taskId}(blocked_by=${(item.runtimeTask.blockedBy ?? []).join("|") || "unknown"})`
      );
    const rolePrompt = input.rolePrompt?.trim() ?? "";
    const agentWorkspace = path.join(input.run.workspacePath, "Agents", input.role);
    return [
      `You are agent role '${input.role}' in workflow run '${input.run.runId}'.`,
      `TeamWorkSpace=${input.run.workspacePath} (shared workflow root; final deliverables belong here).`,
      `YourWorkspace=${agentWorkspace} (role-local working directory; do not keep final outputs only here).`,
      "Runtime mode: static team rules are in local AGENTS.md.",
      `Workflow objective: ${input.run.description ?? input.run.name}`,
      `Dispatch kind: ${input.dispatchKind}.`,
      `Assigned task id: ${input.taskId ?? "(none)"}`,
      `Current task state: ${input.taskState ?? "UNKNOWN"}`,
      `Focus task id (this turn): ${input.taskId ?? "(none)"}`,
      `This turn should operate on: ${input.taskId ?? "(none)"} (focus task first).`,
      `Visible actionable tasks (same role): ${visibleActionableTasks.join(", ") || "(none)"}`,
      `Visible blocked tasks (same role): ${visibleBlockedTasks.join(", ") || "(none)"}`,
      `Message type: ${messageType}`,
      messageContent ? `Message content:\n${messageContent}` : "Message content: (none)",
      task
        ? `Task context:\n- title: ${task.resolvedTitle}\n- owner: ${task.ownerRole}\n- parent: ${task.parentTaskId ?? "(none)"}\n- dependencies: ${focusDependencyIds.join(", ") || "(none)"}\n- dependency_states: ${dependencyStatus}\n- dependencies_ready: ${unresolvedFocusDependencies.length === 0 ? "true" : "false"}\n- unresolved_dependencies: ${unresolvedFocusDependencies.join(", ") || "(none)"}\n- acceptance: ${(task.acceptance ?? []).join(" | ") || "(none)"}\n- artifacts: ${(task.artifacts ?? []).join(", ") || "(none)"}`
        : "Task context: (none)",
      rolePrompt ? `Role system prompt:\n${rolePrompt}` : "",
      "Execution contract:",
      "1) Execute immediately and produce concrete progress/artifacts.",
      "2) Shared deliverables must be written under TeamWorkSpace/docs/** or TeamWorkSpace/src/** (not only inside YourWorkspace).",
      "3) Use workflow task actions via manager APIs only (TASK_CREATE/TASK_DISCUSS_*/TASK_REPORT).",
      "4) Focus task first: prioritize this-turn focus task over other visible tasks.",
      "5) Non-focus task report is allowed only when dependencies are already satisfied; treat it as non-preferred side work.",
      "6) Never report IN_PROGRESS/DONE/MAY_BE_DONE for tasks whose dependencies are not ready.",
      "7) If report fails due to dependencies, wait for dependency completion signal/reminder and then retry; retract or downgrade conflicting premature completion claims to draft.",
      "8) If blocked, report BLOCKED_DEP with concrete blockers.",
      "9) On completion, report DONE for the phase task, not only subtasks."
    ]
      .filter((line) => line.length > 0)
      .join("\n\n");
  }

  private async launchMiniMaxDispatch(input: {
    run: WorkflowRunRecord;
    session: WorkflowSessionRecord;
    role: string;
    dispatchKind: "task" | "message";
    taskId: string | null;
    message: WorkflowManagerToAgentMessage | null;
    requestId: string;
    messageId?: string;
    dispatchId: string;
  }): Promise<void> {
    const runId = input.run.runId;
    let requestedSkillIds: string[] = [];
    try {
      const agents = await listAgents(this.dataRoot);
      const runRoles = Array.from(
        new Set(
          [...input.run.tasks.map((item) => item.ownerRole), input.role]
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        )
      );
      const rolePromptMap = buildRolePromptMapForRoles(agents);
      const roleSummaryMap = new Map(agents.map((item) => [item.agentId, item.summary ?? ""]));
      const workspaceProject: ProjectRecord = {
        schemaVersion: "1.0",
        projectId: `workflow-${input.run.runId}`,
        name: input.run.name,
        workspacePath: input.run.workspacePath,
        agentIds: runRoles,
        createdAt: input.run.createdAt,
        updatedAt: input.run.updatedAt
      };
      await ensureAgentWorkspaces(workspaceProject, rolePromptMap, runRoles, roleSummaryMap);
      const roleAgent = agents.find((item) => item.agentId === input.role);
      const rolePromptRaw = rolePromptMap.get(input.role);
      const rolePrompt = rolePromptRaw?.trim() || buildDefaultRolePrompt(input.role);
      requestedSkillIds = await resolveSkillIdsForAgent(this.dataRoot, roleAgent?.skillList);
      const importedSkillPrompt = await resolveImportedSkillPromptSegments(this.dataRoot, requestedSkillIds);

      const settings = await getRuntimeSettings(this.dataRoot);
      const providerId = input.session.provider ?? resolveSessionProviderId(input.run, input.role, "minimax");
      const tokenLimit = settings.minimaxTokenLimit ?? 180000;
      const maxOutputTokens = settings.minimaxMaxOutputTokens ?? 16384;

      await appendWorkflowRunEvent(this.dataRoot, runId, {
        eventType: "ORCHESTRATOR_DISPATCH_STARTED",
        source: "system",
        sessionId: input.session.sessionId,
        taskId: input.taskId ?? undefined,
        payload: {
          requestId: input.requestId,
          dispatchId: input.dispatchId,
          runId,
          dispatchKind: input.dispatchKind,
          messageId: input.messageId ?? null,
          requestedSkillIds,
          tokenLimit,
          maxOutputTokens
        }
      });

      if (providerId === "minimax" && !settings.minimaxApiKey) {
        await appendWorkflowRunEvent(this.dataRoot, runId, {
          eventType: "ORCHESTRATOR_DISPATCH_FAILED",
          source: "system",
          sessionId: input.session.sessionId,
          taskId: input.taskId ?? undefined,
          payload: {
            requestId: input.requestId,
            dispatchId: input.dispatchId,
            runId,
            dispatchKind: input.dispatchKind,
            messageId: input.messageId ?? null,
            requestedSkillIds,
            error: "minimax_not_configured"
          }
        });
        await touchWorkflowSession(this.dataRoot, runId, input.session.sessionId, {
          status: "dismissed",
          errorStreak: (input.session.errorStreak ?? 0) + 1,
          lastFailureAt: new Date().toISOString(),
          lastFailureKind: "error",
          cooldownUntil: null,
          agentPid: null
        });
        return;
      }

      const runtime = await this.getRunTaskRuntime(runId);
      const runtimeTask = input.taskId ? (runtime.tasks.find((item) => item.taskId === input.taskId) ?? null) : null;
      const prompt = this.buildDispatchPrompt({
        run: input.run,
        role: input.role,
        taskId: input.taskId,
        dispatchKind: input.dispatchKind,
        message: input.message,
        taskState: runtimeTask?.state ?? null,
        runtimeTasks: runtime.tasks,
        rolePrompt
      });

      const agentWorkspaceDir = path.join(input.run.workspacePath, "Agents", input.role);
      await fs.mkdir(agentWorkspaceDir, { recursive: true });
      const providerSessionId = input.session.providerSessionId?.trim() || input.session.sessionId;
      const toolInjection = DefaultToolInjector.build(
        createWorkflowToolExecutionAdapter({
          dataRoot: this.dataRoot,
          run: input.run,
          agentRole: input.role,
          sessionId: input.session.sessionId,
          activeTaskId: input.taskId ?? undefined,
          activeRequestId: input.requestId,
          parentRequestId: input.requestId,
          applyTaskAction: async (request) =>
            (await this.applyTaskActions(runId, request)) as unknown as Record<string, unknown>,
          sendRunMessage: async (request) =>
            (await this.sendRunMessage({ runId, ...request })) as unknown as Record<string, unknown>
        })
      );
      const dispatchRunResult = await providerRegistry.runSessionWithTools(providerId, settings, {
        prompt,
        providerSessionId,
        workspaceDir: agentWorkspaceDir,
        workspaceRoot: input.run.workspacePath,
        role: input.role,
        rolePrompt,
        skillIds: requestedSkillIds,
        skillSegments: importedSkillPrompt.segments,
        contextKind: "workflow_dispatch",
        contextOverride: input.taskId ? `Active task: ${input.taskId}` : undefined,
        runtimeConstraints: ["Report phase completion via TASK_REPORT on the phase task."],
        sessionDirFallback: path.join(input.run.workspacePath, ".minimax", "sessions"),
        apiBaseFallback: "https://api.minimax.io",
        modelFallback: "MiniMax-M2.5-High-speed",
        teamToolContext: toolInjection.teamToolContext,
        teamToolBridge: toolInjection.teamToolBridge,
        env: {
          AUTO_DEV_WORKFLOW_RUN_ID: runId,
          AUTO_DEV_SESSION_ID: input.session.sessionId,
          AUTO_DEV_AGENT_ROLE: input.role,
          AUTO_DEV_WORKFLOW_ROOT: input.run.workspacePath,
          AUTO_DEV_AGENT_WORKSPACE: agentWorkspaceDir,
          AUTO_DEV_MANAGER_URL: process.env.AUTO_DEV_MANAGER_URL ?? "http://127.0.0.1:43123"
        },
        callback: {
          onThinking: () => void this.touchSessionHeartbeat(runId, input.session.sessionId),
          onToolCall: () => void this.touchSessionHeartbeat(runId, input.session.sessionId),
          onToolResult: () => void this.touchSessionHeartbeat(runId, input.session.sessionId),
          onMessage: () => void this.touchSessionHeartbeat(runId, input.session.sessionId),
          onError: () => void this.touchSessionHeartbeat(runId, input.session.sessionId),
          onMaxTokensRecovery: async (event) => {
            await this.touchSessionHeartbeat(runId, input.session.sessionId);
            await appendWorkflowRunEvent(this.dataRoot, runId, {
              eventType: "MINIMAX_MAX_TOKENS_RECOVERY",
              source: "system",
              sessionId: input.session.sessionId,
              taskId: input.taskId ?? undefined,
              payload: {
                requestId: input.requestId,
                dispatchId: input.dispatchId,
                runId,
                dispatchKind: input.dispatchKind,
                messageId: input.messageId ?? null,
                tokenLimit,
                maxOutputTokens,
                ...event
              }
            });
          }
        }
      });

      const dispatchTimedOut = await this.wasDispatchTimedOut(runId, input.session.sessionId, input.dispatchId);
      const dispatchClosed = await this.isDispatchClosed(runId, input.dispatchId);
      if (dispatchTimedOut) {
        if (!dispatchClosed) {
          await appendWorkflowRunEvent(this.dataRoot, runId, {
            eventType: "ORCHESTRATOR_DISPATCH_FINISHED",
            source: "system",
            sessionId: input.session.sessionId,
            taskId: input.taskId ?? undefined,
            payload: {
              requestId: input.requestId,
              dispatchId: input.dispatchId,
              runId,
              dispatchKind: input.dispatchKind,
              messageId: input.messageId ?? null,
              requestedSkillIds,
              exitCode: null,
              timedOut: true,
              synthetic: true,
              reason: "dispatch_timed_out_before_finish",
              finishReason: dispatchRunResult.finishReason ?? null,
              usage: dispatchRunResult.usage ?? null,
              maxOutputTokens: dispatchRunResult.maxOutputTokens ?? maxOutputTokens,
              tokenLimit: dispatchRunResult.tokenLimit ?? tokenLimit,
              maxTokensRecoveryAttempt: dispatchRunResult.maxTokensRecoveryAttempt ?? 0,
              maxTokensSnapshotPath: dispatchRunResult.maxTokensSnapshotPath ?? null,
              recoveredFromMaxTokens: dispatchRunResult.recoveredFromMaxTokens ?? false
            }
          });
        }
        return;
      }
      if (dispatchClosed) {
        return;
      }

      await touchWorkflowSession(this.dataRoot, runId, input.session.sessionId, {
        status: "idle",
        currentTaskId: null,
        providerSessionId,
        timeoutStreak: 0,
        errorStreak: 0,
        lastFailureAt: null,
        lastFailureKind: null,
        cooldownUntil: null,
        lastRunId: runId
      });
      await appendWorkflowRunEvent(this.dataRoot, runId, {
        eventType: "ORCHESTRATOR_DISPATCH_FINISHED",
        source: "system",
        sessionId: input.session.sessionId,
        taskId: input.taskId ?? undefined,
        payload: {
          requestId: input.requestId,
          dispatchId: input.dispatchId,
          runId,
          dispatchKind: input.dispatchKind,
          messageId: input.messageId ?? null,
          requestedSkillIds,
          finishReason: dispatchRunResult.finishReason ?? null,
          usage: dispatchRunResult.usage ?? null,
          maxOutputTokens: dispatchRunResult.maxOutputTokens ?? maxOutputTokens,
          tokenLimit: dispatchRunResult.tokenLimit ?? tokenLimit,
          maxTokensRecoveryAttempt: dispatchRunResult.maxTokensRecoveryAttempt ?? 0,
          maxTokensSnapshotPath: dispatchRunResult.maxTokensSnapshotPath ?? null,
          recoveredFromMaxTokens: dispatchRunResult.recoveredFromMaxTokens ?? false
        }
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const dispatchTimedOut = await this.wasDispatchTimedOut(runId, input.session.sessionId, input.dispatchId);
      const dispatchClosed = await this.isDispatchClosed(runId, input.dispatchId);
      if (!dispatchClosed && !dispatchTimedOut) {
        await appendWorkflowRunEvent(this.dataRoot, runId, {
          eventType: "ORCHESTRATOR_DISPATCH_FAILED",
          source: "system",
          sessionId: input.session.sessionId,
          taskId: input.taskId ?? undefined,
          payload: {
            requestId: input.requestId,
            dispatchId: input.dispatchId,
            runId,
            dispatchKind: input.dispatchKind,
            messageId: input.messageId ?? null,
            requestedSkillIds,
            error: reason
          }
        });
      }
      if (dispatchTimedOut) {
        return;
      }
      const latestSession = await getWorkflowSession(this.dataRoot, runId, input.session.sessionId);
      await touchWorkflowSession(this.dataRoot, runId, input.session.sessionId, {
        status: "dismissed",
        errorStreak: (latestSession?.errorStreak ?? 0) + 1,
        lastFailureAt: new Date().toISOString(),
        lastFailureKind: "error",
        cooldownUntil: null,
        agentPid: null,
        lastRunId: runId
      }).catch(() => {});
    }
  }

  private async isDispatchClosed(runId: string, dispatchId: string): Promise<boolean> {
    const events = await listWorkflowRunEvents(this.dataRoot, runId);
    return events.some((event) => {
      if (event.eventType !== "ORCHESTRATOR_DISPATCH_FINISHED" && event.eventType !== "ORCHESTRATOR_DISPATCH_FAILED") {
        return false;
      }
      const payload = event.payload as Record<string, unknown>;
      return readPayloadString(payload, "dispatchId") === dispatchId;
    });
  }

  private async wasDispatchTimedOut(runId: string, sessionId: string, dispatchId: string): Promise<boolean> {
    const events = await listWorkflowRunEvents(this.dataRoot, runId);
    return events.some((event) => {
      if (event.sessionId !== sessionId) {
        return false;
      }
      if (
        event.eventType !== "SESSION_HEARTBEAT_TIMEOUT" &&
        event.eventType !== "RUNNER_TIMEOUT_SOFT" &&
        event.eventType !== "RUNNER_TIMEOUT_ESCALATED"
      ) {
        return false;
      }
      const payload = event.payload as Record<string, unknown>;
      return readPayloadString(payload, "dispatchId") === dispatchId;
    });
  }

  private async checkRoleReminders(
    run: WorkflowRunRecord,
    runtime: WorkflowRunRuntimeState,
    sessions: WorkflowSessionRecord[]
  ): Promise<void> {
    if (!this.options.autoReminderEnabled) {
      return;
    }
    const nowMs = Date.now();
    const reminderMode = normalizeReminderMode(run.reminderMode);
    const maxRetries = this.options.reminderMaxCount;
    const backoffMultiplier = this.options.reminderBackoffMultiplier;
    const maxIntervalMs = this.options.reminderMaxIntervalMs;
    const runtimeByTaskId = new Map(runtime.tasks.map((item) => [item.taskId, item]));
    const roleSet = new Set<string>();
    for (const session of sessions) {
      roleSet.add(session.role);
    }
    for (const task of run.tasks) {
      if (task.ownerRole.trim().length > 0) {
        roleSet.add(task.ownerRole.trim());
      }
    }

    for (const role of Array.from(roleSet).sort((a, b) => a.localeCompare(b))) {
      const session = await this.resolveAuthoritativeSession(run.runId, role, sessions, run, "reminder");
      const currentRoleState = getRoleState(session);
      const roleOpenTasks = run.tasks
        .flatMap((task) => {
          if (task.ownerRole !== role) {
            return [];
          }
          const runtimeTask = runtimeByTaskId.get(task.taskId);
          if (!runtimeTask || !isRemindableTaskState(runtimeTask.state)) {
            return [];
          }
          return [
            {
              taskId: task.taskId,
              title: task.title,
              resolvedTitle: task.resolvedTitle,
              parentTaskId: task.parentTaskId,
              ownerRole: task.ownerRole,
              dependencies: task.dependencies,
              writeSet: task.writeSet,
              acceptance: task.acceptance,
              artifacts: task.artifacts,
              state: runtimeTask.state,
              summary: runtimeTask.lastSummary,
              createdAt: runtimeTask.lastTransitionAt ?? run.createdAt
            }
          ];
        })
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const hasOpenTask = roleOpenTasks.length > 0;
      const sessionIdleSince = session ? (session.lastDispatchedAt ?? session.updatedAt) : undefined;

      let reminderState = await getWorkflowRoleReminderState(this.dataRoot, run.runId, role);
      if (!reminderState) {
        reminderState = await updateWorkflowRoleReminderState(this.dataRoot, run.runId, role, {
          idleSince: sessionIdleSince,
          reminderCount: 0,
          lastRoleState: currentRoleState
        });
      }

      const previousRoleState = reminderState.lastRoleState ?? "INACTIVE";
      if (shouldAutoResetReminderOnRoleTransition(previousRoleState, currentRoleState)) {
        reminderState = await updateWorkflowRoleReminderState(this.dataRoot, run.runId, role, {
          reminderCount: 0,
          nextReminderAt: calculateNextReminderTimeByMode(reminderMode, 0, nowMs, {
            initialWaitMs: this.options.idleReminderMs,
            backoffMultiplier,
            maxWaitMs: maxIntervalMs
          }),
          idleSince: sessionIdleSince,
          lastRoleState: "IDLE"
        });
      } else if (previousRoleState !== "IDLE" && currentRoleState === "IDLE") {
        reminderState = await updateWorkflowRoleReminderState(this.dataRoot, run.runId, role, {
          idleSince: sessionIdleSince,
          nextReminderAt: calculateNextReminderTimeByMode(reminderMode, reminderState.reminderCount, nowMs, {
            initialWaitMs: this.options.idleReminderMs,
            backoffMultiplier,
            maxWaitMs: maxIntervalMs
          }),
          lastRoleState: "IDLE"
        });
      } else if (currentRoleState !== "IDLE") {
        reminderState = await updateWorkflowRoleReminderState(this.dataRoot, run.runId, role, {
          lastRoleState: currentRoleState
        });
      } else {
        reminderState = await updateWorkflowRoleReminderState(this.dataRoot, run.runId, role, {
          lastRoleState: "IDLE"
        });
      }

      if (currentRoleState !== "IDLE" || !session) {
        continue;
      }

      if (!hasOpenTask) {
        await updateWorkflowRoleReminderState(this.dataRoot, run.runId, role, {
          reminderCount: 0,
          nextReminderAt: undefined,
          lastRoleState: "IDLE"
        });
        continue;
      }

      const nextReminderTime = reminderState.nextReminderAt ? Date.parse(reminderState.nextReminderAt) : Number.NaN;
      if (reminderState.reminderCount >= maxRetries) {
        continue;
      }
      if (!reminderState.idleSince) {
        continue;
      }
      if (!Number.isFinite(nextReminderTime)) {
        await updateWorkflowRoleReminderState(this.dataRoot, run.runId, role, {
          nextReminderAt: calculateNextReminderTimeByMode(reminderMode, reminderState.reminderCount, nowMs, {
            initialWaitMs: this.options.idleReminderMs,
            backoffMultiplier,
            maxWaitMs: maxIntervalMs
          }),
          lastRoleState: "IDLE"
        });
        continue;
      }
      if (nowMs < nextReminderTime) {
        continue;
      }

      const nextReminderAt = calculateNextReminderTimeByMode(reminderMode, reminderState.reminderCount, nowMs, {
        initialWaitMs: this.options.idleReminderMs,
        backoffMultiplier,
        maxWaitMs: maxIntervalMs
      });
      reminderState = await updateWorkflowRoleReminderState(this.dataRoot, run.runId, role, {
        reminderCount: reminderState.reminderCount + 1,
        nextReminderAt,
        lastRoleState: "IDLE"
      });

      const reminderMessageId = `reminder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const reminderRequestId = randomUUID();
      const primaryTask = roleOpenTasks[0] ?? null;
      const primaryTaskId = primaryTask?.taskId ?? null;
      const openTaskTitlePreview = roleOpenTasks
        .slice(0, 3)
        .map((task) => `${task.taskId}: ${task.resolvedTitle}`)
        .join("; ");
      const content =
        `Reminder: you have ${roleOpenTasks.length} open task(s) without recent progress. ` +
        (openTaskTitlePreview.length > 0 ? `Open tasks: ${openTaskTitlePreview}. ` : "") +
        `Please continue execution and submit TASK_REPORT for current work.`;

      const message: WorkflowManagerToAgentMessage = {
        envelope: {
          message_id: reminderMessageId,
          run_id: run.runId,
          timestamp: new Date().toISOString(),
          sender: { type: "system", role: "manager", session_id: "manager-system" },
          via: { type: "manager" },
          intent: "MANAGER_MESSAGE",
          priority: "normal",
          correlation: {
            request_id: reminderRequestId,
            parent_request_id: reminderRequestId,
            task_id: primaryTaskId ?? undefined
          },
          accountability: {
            owner_role: role,
            report_to: { role: "manager", session_id: "manager-system" },
            expect: "TASK_REPORT"
          },
          dispatch_policy: "fixed_session"
        },
        body: buildReminderMessageBody({
          role,
          reminderMode,
          reminderCount: reminderState.reminderCount,
          nextReminderAt: reminderState.nextReminderAt ?? null,
          openTasks: roleOpenTasks.map((task) => ({
            taskId: task.taskId,
            title: task.resolvedTitle
          })),
          content,
          primaryTaskId,
          primarySummary: primaryTask?.summary ?? "",
          primaryTask:
            primaryTask === null
              ? null
              : {
                  task_id: primaryTask.taskId,
                  state: primaryTask.state,
                  owner_role: primaryTask.ownerRole,
                  parent_task_id: primaryTask.parentTaskId ?? null,
                  write_set: primaryTask.writeSet ?? [],
                  dependencies: primaryTask.dependencies ?? [],
                  acceptance: primaryTask.acceptance ?? [],
                  artifacts: primaryTask.artifacts ?? []
                }
        })
      };
      await appendWorkflowInboxMessage(this.dataRoot, run.runId, role, message);
      await appendWorkflowRunEvent(this.dataRoot, run.runId, {
        eventType: "ORCHESTRATOR_ROLE_REMINDER_TRIGGERED",
        source: "system",
        sessionId: session.sessionId,
        taskId: primaryTaskId ?? undefined,
        payload: {
          role,
          requestId: reminderRequestId,
          messageId: reminderMessageId,
          reminderMode,
          reminderCount: reminderState.reminderCount,
          nextReminderAt: reminderState.nextReminderAt ?? null,
          openTaskIds: roleOpenTasks.map((task) => task.taskId),
          openTaskTitles: roleOpenTasks.map((task) => ({
            task_id: task.taskId,
            title: task.resolvedTitle
          }))
        }
      });
      const redispatchResult = await this.dispatchRun(run.runId, {
        source: "loop",
        role,
        force: false,
        onlyIdle: false,
        maxDispatches: 1
      });
      const redispatchOutcome = redispatchResult.results[0]?.outcome ?? "no_message";
      await appendWorkflowRunEvent(this.dataRoot, run.runId, {
        eventType: "ORCHESTRATOR_ROLE_REMINDER_REDISPATCH",
        source: "system",
        sessionId: session.sessionId,
        taskId: primaryTaskId ?? undefined,
        payload: {
          role,
          outcome: redispatchOutcome
        }
      });
    }
  }

  private async checkAndMarkMayBeDone(run: WorkflowRunRecord, runtime: WorkflowRunRuntimeState): Promise<void> {
    const mayBeDoneEnabled = String(process.env.MAY_BE_DONE_ENABLED ?? "1").trim() !== "0";
    if (!mayBeDoneEnabled) {
      return;
    }

    const thresholdRaw = Number(process.env.MAY_BE_DONE_DISPATCH_THRESHOLD ?? MAY_BE_DONE_DISPATCH_THRESHOLD);
    const threshold =
      Number.isFinite(thresholdRaw) && thresholdRaw > 0 ? Math.floor(thresholdRaw) : MAY_BE_DONE_DISPATCH_THRESHOLD;
    const windowRaw = Number(process.env.MAY_BE_DONE_CHECK_WINDOW_MS ?? MAY_BE_DONE_CHECK_WINDOW_MS);
    const windowMs = Number.isFinite(windowRaw) && windowRaw > 0 ? Math.floor(windowRaw) : MAY_BE_DONE_CHECK_WINDOW_MS;

    const nonTerminalTasks = runtime.tasks.filter((task) => task.state !== "DONE" && task.state !== "CANCELED");
    if (nonTerminalTasks.length === 0) {
      return;
    }

    const events = await listWorkflowRunEvents(this.dataRoot, run.runId);
    const cutoff = Date.now() - windowMs;
    const recentEvents = events.filter((event) => Date.parse(event.createdAt) >= cutoff);

    let changed = false;
    for (const task of nonTerminalTasks) {
      if (task.state === "MAY_BE_DONE") {
        continue;
      }
      const taskDispatchEvents = recentEvents.filter((event) => {
        if (event.taskId !== task.taskId || event.eventType !== "ORCHESTRATOR_DISPATCH_STARTED") {
          return false;
        }
        const payload = event.payload as Record<string, unknown>;
        return readPayloadString(payload, "dispatchKind") === "task";
      });
      const dispatchCount = taskDispatchEvents.length;
      if (dispatchCount < threshold) {
        continue;
      }
      const hasValidOutput = await this.hasValidAgentOutput(run, task, recentEvents);
      if (!hasValidOutput) {
        continue;
      }

      this.addTransition(runtime, task, "MAY_BE_DONE");
      await appendWorkflowRunEvent(this.dataRoot, run.runId, {
        eventType: "TASK_MAY_BE_DONE_MARKED",
        source: "system",
        taskId: task.taskId,
        payload: {
          dispatchCount,
          threshold,
          windowMs,
          reason: "dispatch_threshold_exceeded_with_valid_output"
        }
      });
      logger.info(
        `[workflow-orchestrator] checkAndMarkMayBeDone: runId=${run.runId}, taskId=${task.taskId}, dispatchCount=${dispatchCount}`
      );
      changed = true;
    }

    if (changed) {
      await writeWorkflowRunTaskRuntimeState(this.dataRoot, run.runId, runtime);
      await patchWorkflowRun(this.dataRoot, run.runId, { runtime });
    }
  }

  private async hasValidAgentOutput(
    run: WorkflowRunRecord,
    task: WorkflowTaskRuntimeRecord,
    recentEvents: WorkflowRunEventRecord[]
  ): Promise<boolean> {
    if (task.lastSummary && task.lastSummary.trim().length > 0) {
      return true;
    }

    const runFinishedEvents = recentEvents.filter(
      (event) =>
        event.taskId === task.taskId &&
        (event.eventType === "CODEX_RUN_FINISHED" || event.eventType === "MINIMAX_RUN_FINISHED")
    );
    for (const event of runFinishedEvents) {
      const payload = event.payload as Record<string, unknown>;
      const exitCode = payload.exitCode;
      if (typeof exitCode === "number" && exitCode === 0) {
        return true;
      }
    }

    const ownerRole = run.tasks.find((item) => item.taskId === task.taskId)?.ownerRole?.trim();
    if (ownerRole) {
      const progressFile = path.resolve(run.workspacePath, "Agents", ownerRole, "progress.md");
      try {
        const content = await fs.readFile(progressFile, "utf8");
        const normalized = content.replace(/^\uFEFF/, "").trim();
        if (normalized.length > 50) {
          return true;
        }
      } catch {
        // File doesn't exist or can't be read.
      }
    }

    return false;
  }

  private async markTimedOutSessions(run: WorkflowRunRecord, sessions: WorkflowSessionRecord[]): Promise<void> {
    const nowMs = Date.now();
    const threshold = getTimeoutEscalationThreshold();
    const cooldownMs = getTimeoutCooldownMs();
    const settings = await getRuntimeSettings(this.dataRoot);
    const events = await listWorkflowRunEvents(this.dataRoot, run.runId);
    const roleCandidates = Array.from(
      new Set(sessions.filter((session) => session.status !== "dismissed").map((session) => session.role))
    ).sort((a, b) => a.localeCompare(b));
    for (const role of roleCandidates) {
      const session = await this.resolveAuthoritativeSession(run.runId, role, sessions, run, "timeout_check");
      if (!session) {
        continue;
      }
      if (session.status !== "running") {
        continue;
      }
      const lastActiveMs = parseIsoMs(session.lastActiveAt ?? session.updatedAt);
      if (!Number.isFinite(lastActiveMs)) {
        continue;
      }
      if (nowMs - lastActiveMs < this.options.sessionRunningTimeoutMs) {
        continue;
      }
      const providerId = session.provider ?? resolveSessionProviderId(run, session.role, "minimax");
      const cancelSessionId = session.providerSessionId?.trim() || session.sessionId;
      const cancelRequested = providerRegistry.cancelSession(providerId, cancelSessionId);
      const sessionEvents = events.filter((event) => event.sessionId === session.sessionId);
      const openDispatch = findLatestOpenDispatch(sessionEvents);
      const currentTaskId = session.currentTaskId ?? openDispatch?.event.taskId ?? null;
      const dispatchId = openDispatch?.dispatchId ?? session.lastDispatchId ?? null;
      const timeoutStreak = (session.timeoutStreak ?? 0) + 1;
      const escalated = timeoutStreak >= threshold;
      const cooldownUntil =
        escalated || cooldownMs <= 0 ? null : new Date(Date.now() + Math.max(0, cooldownMs)).toISOString();
      await touchWorkflowSession(this.dataRoot, run.runId, session.sessionId, {
        status: escalated ? "dismissed" : "idle",
        currentTaskId,
        lastDispatchId: dispatchId,
        timeoutStreak,
        lastFailureAt: new Date().toISOString(),
        lastFailureKind: "timeout",
        cooldownUntil,
        agentPid: null,
        lastRunId: run.runId
      }).catch(() => {});
      const timeoutDump =
        !escalated && providerId === "minimax"
          ? await dumpSessionMessagesOnSoftTimeout({
              workspacePath: run.workspacePath,
              sessionDir: settings.minimaxSessionDir,
              sessionId: session.sessionId,
              providerSessionId: session.providerSessionId,
              runId: run.runId,
              role: session.role,
              provider: providerId,
              dispatchId,
              taskId: currentTaskId ?? null,
              timeoutStreak
            })
          : null;
      if (openDispatch) {
        const payload = openDispatch.event.payload as Record<string, unknown>;
        await appendWorkflowRunEvent(this.dataRoot, run.runId, {
          eventType: escalated ? "ORCHESTRATOR_DISPATCH_FAILED" : "ORCHESTRATOR_DISPATCH_FINISHED",
          source: "system",
          sessionId: session.sessionId,
          taskId: currentTaskId ?? undefined,
          payload: {
            dispatchId: openDispatch.dispatchId,
            mode: payload.mode ?? "loop",
            dispatchKind: payload.dispatchKind ?? "task",
            messageId: payload.messageId ?? null,
            requestId: payload.requestId ?? null,
            runId: run.runId,
            exitCode: null,
            timedOut: true,
            synthetic: true,
            reason: "session_heartbeat_timeout",
            ...(escalated ? { error: "session heartbeat timeout escalated" } : {})
          }
        });
      }
      await appendWorkflowRunEvent(this.dataRoot, run.runId, {
        eventType: "SESSION_HEARTBEAT_TIMEOUT",
        source: "system",
        sessionId: session.sessionId,
        taskId: currentTaskId ?? undefined,
        payload: {
          previousStatus: "running",
          timeoutMs: this.options.sessionRunningTimeoutMs,
          lastActiveAt: session.lastActiveAt,
          provider: providerId,
          providerSessionId: cancelSessionId,
          cancelRequested,
          timeoutStreak,
          threshold,
          escalated,
          cooldownUntil,
          dispatchId
        }
      });
      await appendWorkflowRunEvent(this.dataRoot, run.runId, {
        eventType: escalated ? "RUNNER_TIMEOUT_ESCALATED" : "RUNNER_TIMEOUT_SOFT",
        source: "system",
        sessionId: session.sessionId,
        taskId: currentTaskId ?? undefined,
        payload: {
          runId: run.runId,
          dispatchId,
          timeoutStreak,
          threshold,
          cooldownUntil,
          timeoutMessageDumpPath: timeoutDump?.filePath ?? null,
          timeoutMessageCount: timeoutDump?.messageCount ?? null
        }
      });
    }
  }

  private countUnfinishedTasks(runtime: WorkflowRunRuntimeState): number {
    return runtime.tasks.reduce((count, task) => (isTerminalState(task.state) ? count : count + 1), 0);
  }

  private countRunningSessions(sessions: WorkflowSessionRecord[]): number {
    return sessions.reduce((count, session) => (session.status === "running" ? count + 1 : count), 0);
  }

  private async checkAndFinalizeRunByStableWindow(
    run: WorkflowRunRecord,
    runtime: WorkflowRunRuntimeState,
    sessions: WorkflowSessionRecord[]
  ): Promise<boolean> {
    const unfinishedTaskCount = this.countUnfinishedTasks(runtime);
    const runningSessionCount = this.countRunningSessions(sessions);
    const previousStableTicks = this.runAutoFinishStableTicks.get(run.runId) ?? 0;
    const eligible = unfinishedTaskCount === 0 && runningSessionCount === 0;

    if (!eligible) {
      if (previousStableTicks > 0) {
        this.runAutoFinishStableTicks.set(run.runId, 0);
        await appendWorkflowRunEvent(this.dataRoot, run.runId, {
          eventType: "ORCHESTRATOR_RUN_AUTO_FINISH_WINDOW_RESET",
          source: "system",
          payload: {
            previousStableTicks,
            stableTicks: 0,
            requiredStableTicks: AUTO_FINISH_STABLE_TICKS_REQUIRED,
            unfinishedTaskCount,
            runningSessionCount
          }
        });
      }
      return false;
    }

    const stableTicks = previousStableTicks + 1;
    this.runAutoFinishStableTicks.set(run.runId, stableTicks);
    await appendWorkflowRunEvent(this.dataRoot, run.runId, {
      eventType: "ORCHESTRATOR_RUN_AUTO_FINISH_WINDOW_TICK",
      source: "system",
      payload: {
        stableTicks,
        requiredStableTicks: AUTO_FINISH_STABLE_TICKS_REQUIRED,
        unfinishedTaskCount,
        runningSessionCount
      }
    });

    if (stableTicks < AUTO_FINISH_STABLE_TICKS_REQUIRED) {
      return false;
    }

    const now = new Date().toISOString();
    await patchWorkflowRun(this.dataRoot, run.runId, {
      runtime,
      status: "finished",
      stoppedAt: now,
      lastHeartbeatAt: now
    });
    this.activeRunIds.delete(run.runId);
    this.clearRunScopedState(run.runId);
    await appendWorkflowRunEvent(this.dataRoot, run.runId, {
      eventType: "ORCHESTRATOR_RUN_AUTO_FINISHED",
      source: "system",
      payload: {
        stableTicks,
        requiredStableTicks: AUTO_FINISH_STABLE_TICKS_REQUIRED,
        unfinishedTaskCount,
        runningSessionCount,
        finishedAt: now
      }
    });
    return true;
  }

  private async tickLoop(): Promise<void> {
    const runs = await listWorkflowRuns(this.dataRoot);
    const runningRunIds = new Set(runs.filter((run) => run.status === "running").map((run) => run.runId));
    this.pruneInactiveRunScopedState(runningRunIds);
    this.activeRunIds.clear();
    await runOrchestratorAdapterTick({
      listContexts: async () => runs,
      tickContext: async (run) => {
        if (run.status !== "running") {
          return;
        }
        this.activeRunIds.add(run.runId);
        const runtime = await this.ensureRuntime(run);
        const sessions = await listWorkflowSessions(this.dataRoot, run.runId);

        const holdEnabled = Boolean(run.holdEnabled);
        const previousHold = this.runHoldState.get(run.runId);
        if (previousHold === undefined || previousHold !== holdEnabled) {
          await appendWorkflowRunEvent(this.dataRoot, run.runId, {
            eventType: holdEnabled ? "ORCHESTRATOR_RUN_HOLD_ENABLED" : "ORCHESTRATOR_RUN_HOLD_DISABLED",
            source: "system",
            payload: { holdEnabled }
          });
          this.runHoldState.set(run.runId, holdEnabled);
        }

        await this.markTimedOutSessions(run, sessions);
        if (await this.checkAndFinalizeRunByStableWindow(run, runtime, sessions)) {
          return;
        }
        if (holdEnabled) {
          return;
        }
        await this.checkRoleReminders(run, runtime, sessions);
        await this.checkAndMarkMayBeDone(run, runtime);

        const enabled = run.autoDispatchEnabled ?? true;
        const remaining = Number(run.autoDispatchRemaining ?? 5);
        if (!enabled || !Number.isFinite(remaining) || remaining <= 0) {
          return;
        }
        await this.dispatchRun(run.runId, {
          source: "loop",
          force: false,
          onlyIdle: true,
          maxDispatches: Math.max(1, Math.floor(remaining))
        });
      }
    });
  }

  async startRun(runId: string): Promise<WorkflowRunRuntimeStatus> {
    const run = await this.loadRunOrThrow(runId);
    const now = new Date().toISOString();
    const updated = await patchWorkflowRun(this.dataRoot, runId, {
      status: "running",
      startedAt: run.startedAt ?? now,
      stoppedAt: null,
      lastHeartbeatAt: now
    });
    this.activeRunIds.add(runId);
    this.runAutoFinishStableTicks.delete(runId);
    const runtime = await this.ensureRuntime(updated);
    await writeWorkflowRunTaskRuntimeState(this.dataRoot, runId, runtime);
    return {
      runId: updated.runId,
      status: updated.status,
      active: true,
      startedAt: updated.startedAt,
      stoppedAt: updated.stoppedAt,
      lastHeartbeatAt: updated.lastHeartbeatAt
    };
  }

  async stopRun(runId: string): Promise<WorkflowRunRuntimeStatus> {
    const run = await this.loadRunOrThrow(runId);
    if (run.status === "finished") {
      this.activeRunIds.delete(runId);
      return {
        runId: run.runId,
        status: run.status,
        active: false,
        startedAt: run.startedAt,
        stoppedAt: run.stoppedAt,
        lastHeartbeatAt: run.lastHeartbeatAt
      };
    }
    const sessions = await listWorkflowSessions(this.dataRoot, runId);
    for (const session of sessions) {
      if (session.status !== "running") {
        continue;
      }
      const providerId = session.provider ?? resolveSessionProviderId(run, session.role, "minimax");
      const cancelSessionId = session.providerSessionId?.trim() || session.sessionId;
      const canceled = providerRegistry.cancelSession(providerId, cancelSessionId);
      await touchWorkflowSession(this.dataRoot, runId, session.sessionId, {
        status: "idle",
        currentTaskId: null,
        agentPid: null,
        cooldownUntil: null
      }).catch(() => {});
      await appendWorkflowRunEvent(this.dataRoot, runId, {
        eventType: "RUN_STOP_SESSION_CANCEL",
        source: "system",
        sessionId: session.sessionId,
        payload: {
          provider: providerId,
          providerSessionId: cancelSessionId,
          canceled
        }
      });
    }
    const now = new Date().toISOString();
    const updated = await patchWorkflowRun(this.dataRoot, runId, {
      status: "stopped",
      stoppedAt: now,
      lastHeartbeatAt: now
    });
    this.activeRunIds.delete(runId);
    this.clearRunScopedState(runId);
    return {
      runId: updated.runId,
      status: updated.status,
      active: false,
      startedAt: updated.startedAt,
      stoppedAt: updated.stoppedAt,
      lastHeartbeatAt: updated.lastHeartbeatAt
    };
  }

  async getRunStatus(runId: string): Promise<WorkflowRunRuntimeStatus> {
    const run = await this.loadRunOrThrow(runId);
    return {
      runId: run.runId,
      status: run.status,
      active: run.status === "running" && this.activeRunIds.has(runId),
      startedAt: run.startedAt,
      stoppedAt: run.stoppedAt,
      lastHeartbeatAt: run.lastHeartbeatAt
    };
  }

  async getRunTaskRuntime(runId: string): Promise<WorkflowRunRuntimeSnapshot> {
    const run = await this.loadRunOrThrow(runId);
    const runtime = await this.ensureRuntime(run);
    return this.toSnapshot(run, runtime);
  }

  async getRunTaskTreeRuntime(runId: string): Promise<WorkflowTaskTreeRuntimeResponse> {
    const run = await this.loadRunOrThrow(runId);
    const runtime = await this.ensureRuntime(run);
    const runtimeByTask = new Map(runtime.tasks.map((item) => [item.taskId, item]));
    const taskIds = new Set(run.tasks.map((item) => item.taskId));
    const roots = run.tasks
      .filter((task) => {
        const parent = task.parentTaskId?.trim();
        return !parent || !taskIds.has(parent);
      })
      .map((task) => task.taskId);
    const edges: WorkflowTaskTreeRuntimeResponse["edges"] = [];
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
      run_id: run.runId,
      generated_at: new Date().toISOString(),
      status: run.status,
      active: run.status === "running" && this.activeRunIds.has(runId),
      roots,
      nodes: run.tasks.map((task) => ({ ...task, runtime: runtimeByTask.get(task.taskId) ?? null })),
      edges,
      counters: computeCounters(runtime.tasks)
    };
  }

  async listRunSessions(runId: string): Promise<{ runId: string; items: WorkflowSessionRecord[] }> {
    await this.loadRunOrThrow(runId);
    return { runId, items: await listWorkflowSessions(this.dataRoot, runId) };
  }

  async registerRunSession(
    runId: string,
    input: {
      role: string;
      sessionId?: string;
      status?: string;
      providerSessionId?: string;
      provider?: "codex" | "trae" | "minimax";
    }
  ): Promise<{ session: WorkflowSessionRecord; created: boolean }> {
    const run = await this.loadRunOrThrow(runId);
    const result = await upsertWorkflowSession(this.dataRoot, runId, {
      sessionId: input.sessionId?.trim() || buildSessionId(input.role),
      role: input.role,
      status: input.status,
      provider: input.provider,
      providerSessionId: input.providerSessionId
    });
    if (result.session.status !== "dismissed") {
      await this.persistRoleSessionMap(run, input.role, result.session.sessionId);
    }
    return result;
  }

  async sendRunMessage(input: {
    runId: string;
    fromAgent: string;
    fromSessionId: string;
    messageType: "MANAGER_MESSAGE" | "TASK_DISCUSS_REQUEST" | "TASK_DISCUSS_REPLY" | "TASK_DISCUSS_CLOSED";
    toRole?: string;
    toSessionId?: string;
    taskId?: string;
    content: string;
    requestId?: string;
    parentRequestId?: string;
    discuss?: { threadId?: string; requestId?: string };
  }): Promise<{
    requestId: string;
    messageId: string;
    messageType: string;
    taskId: string | null;
    toRole: string | null;
    resolvedSessionId: string;
    createdAt: string;
  }> {
    const run = await this.loadRunOrThrow(input.runId);
    const fromAgent = input.fromAgent.trim() || "manager";
    const toRole = input.toRole?.trim();
    const toSessionId = input.toSessionId?.trim();
    if (!toRole && !toSessionId) {
      throw new WorkflowRuntimeError("to.agent (role) or to.session_id is required", "MESSAGE_TARGET_REQUIRED", 400);
    }
    if (toRole && !hasRoutePermission(run, fromAgent, toRole)) {
      throw new WorkflowRuntimeError("route not allowed by workflow route table", "ROUTE_DENIED", 403);
    }
    let session: WorkflowSessionRecord | null = null;
    if (toSessionId) {
      session = await getWorkflowSession(this.dataRoot, input.runId, toSessionId);
      if (!session) throw new WorkflowRuntimeError(`session '${toSessionId}' not found`, "TASK_NOT_FOUND", 404);
    } else if (toRole) {
      const sessions = await listWorkflowSessions(this.dataRoot, input.runId);
      session = await this.resolveAuthoritativeSession(input.runId, toRole, sessions, run, "message_route");
    }
    if (!session) {
      throw new WorkflowRuntimeError("target session cannot be resolved", "MESSAGE_TARGET_REQUIRED", 404);
    }
    const resolvedRole = toRole ?? session.role;
    const requestId = input.requestId?.trim() || `${Date.now()}`;
    const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const createdAt = new Date().toISOString();
    const message: WorkflowManagerToAgentMessage = {
      envelope: {
        message_id: messageId,
        run_id: run.runId,
        timestamp: createdAt,
        sender: {
          type: fromAgent === "manager" ? "system" : "agent",
          role: fromAgent,
          session_id: input.fromSessionId
        },
        via: { type: "manager" },
        intent: input.messageType.startsWith("TASK_DISCUSS") ? "TASK_DISCUSS" : "MANAGER_MESSAGE",
        priority: "normal",
        correlation: { request_id: requestId, parent_request_id: input.parentRequestId, task_id: input.taskId },
        accountability: {
          owner_role: resolvedRole,
          report_to: { role: fromAgent, session_id: input.fromSessionId },
          expect: input.messageType === "TASK_DISCUSS_REQUEST" ? "DISCUSS_REPLY" : "TASK_REPORT"
        },
        dispatch_policy: "fixed_session"
      },
      body: {
        messageType: input.messageType,
        mode: "CHAT",
        content: input.content,
        taskId: input.taskId ?? null,
        discuss: input.discuss ?? null
      }
    };
    await appendWorkflowInboxMessage(this.dataRoot, input.runId, resolvedRole, message);
    await touchWorkflowSession(this.dataRoot, input.runId, session.sessionId, { lastInboxMessageId: messageId });
    await appendWorkflowRunEvent(this.dataRoot, input.runId, {
      eventType: "USER_MESSAGE_RECEIVED",
      source: fromAgent === "manager" ? "manager" : "agent",
      sessionId: input.fromSessionId,
      taskId: input.taskId,
      payload: {
        fromAgent,
        toRole: resolvedRole,
        requestId,
        content: input.content,
        sourceType: fromAgent === "manager" ? "manager" : "agent",
        originAgent: fromAgent
      }
    });
    await appendWorkflowRunEvent(this.dataRoot, input.runId, {
      eventType: "MESSAGE_ROUTED",
      source: "manager",
      sessionId: session.sessionId,
      taskId: input.taskId,
      payload: {
        fromAgent,
        toRole: resolvedRole,
        resolvedSessionId: session.sessionId,
        requestId,
        messageId,
        content: input.content,
        messageType: input.messageType,
        discuss: input.discuss ?? null,
        sourceType: fromAgent === "manager" ? "manager" : "agent",
        originAgent: fromAgent
      }
    });
    return {
      requestId,
      messageId,
      messageType: input.messageType,
      taskId: input.taskId ?? null,
      toRole: resolvedRole,
      resolvedSessionId: session.sessionId,
      createdAt
    };
  }

  private parseOutcome(outcome: string): WorkflowTaskState | null {
    if (outcome === "IN_PROGRESS") return "IN_PROGRESS";
    if (outcome === "BLOCKED_DEP") return "BLOCKED_DEP";
    if (outcome === "MAY_BE_DONE") return "MAY_BE_DONE";
    if (outcome === "DONE") return "DONE";
    if (outcome === "CANCELED") return "CANCELED";
    return null;
  }

  private resolveUnreadyDependencyTaskIds(
    taskDef: WorkflowRunRecord["tasks"][number] | undefined,
    runtimeByTaskId: Map<string, WorkflowTaskRuntimeRecord>,
    stateByTaskId?: Map<string, WorkflowTaskState>
  ): string[] {
    if (!taskDef) {
      return [];
    }
    const unresolved: string[] = [];
    for (const depId of taskDef.dependencies ?? []) {
      const depState = stateByTaskId?.get(depId) ?? runtimeByTaskId.get(depId)?.state;
      if (depState !== "DONE" && depState !== "CANCELED") {
        unresolved.push(depId);
      }
    }
    return unresolved;
  }

  async applyTaskActions(
    runId: string,
    input: WorkflowTaskActionRequest
  ): Promise<Omit<WorkflowTaskActionResult, "requestId">> {
    const run = await this.loadRunOrThrow(runId);
    const runtime = await this.ensureRuntime(run);
    const actionType = input.actionType;
    const byTask = new Map(runtime.tasks.map((item) => [item.taskId, item]));
    const runTaskById = new Map(run.tasks.map((item) => [item.taskId, item]));
    const appliedTaskIds: string[] = [];
    const rejectedResults: WorkflowTaskActionResult["rejectedResults"] = [];
    const fromAgent = input.fromAgent?.trim() || "manager";

    await appendWorkflowRunEvent(this.dataRoot, runId, {
      eventType: "TASK_ACTION_RECEIVED",
      source: fromAgent === "manager" ? "manager" : "agent",
      sessionId: input.fromSessionId,
      taskId: input.taskId,
      payload: {
        actionType,
        fromAgent,
        toRole: input.toRole ?? null,
        toSessionId: input.toSessionId ?? null,
        requestId: input.discuss?.requestId ?? null
      }
    });

    if (
      actionType === "TASK_DISCUSS_REQUEST" ||
      actionType === "TASK_DISCUSS_REPLY" ||
      actionType === "TASK_DISCUSS_CLOSED"
    ) {
      const message = await this.sendRunMessage({
        runId,
        fromAgent,
        fromSessionId: input.fromSessionId?.trim() || "manager-system",
        messageType: actionType,
        toRole: input.toRole,
        toSessionId: input.toSessionId,
        taskId: input.taskId,
        content: input.content?.trim() || "",
        requestId: input.discuss?.requestId,
        discuss: input.discuss
      });
      return {
        success: true,
        actionType,
        messageId: message.messageId,
        partialApplied: false,
        appliedTaskIds,
        rejectedResults,
        snapshot: this.toSnapshot(run, runtime)
      };
    }

    if (actionType === "TASK_CREATE") {
      const task = input.task;
      if (!task) throw new WorkflowRuntimeError("task payload is required", "INVALID_TRANSITION", 400);
      const taskId = task.taskId.trim();
      const ownerRole = task.ownerRole.trim();
      if (!taskId) throw new WorkflowRuntimeError("task.task_id is required", "INVALID_TRANSITION", 400);
      if (run.tasks.some((item) => item.taskId === taskId))
        throw new WorkflowRuntimeError(`task '${taskId}' already exists`, "INVALID_TRANSITION", 409);
      if (!task.title.trim() || !ownerRole)
        throw new WorkflowRuntimeError("task.title and task.owner_role are required", "INVALID_TRANSITION", 400);
      const sessions = await listWorkflowSessions(this.dataRoot, runId);
      const roleScope = resolveWorkflowRunRoleScope(run, sessions);
      if (!roleScope.enabledAgentSet.has(ownerRole)) {
        throw new WorkflowRuntimeError(
          `owner_role '${ownerRole}' does not exist in current run roles`,
          "TASK_OWNER_ROLE_NOT_FOUND",
          409,
          "Call route_targets_get first, choose an allowed target role, and retry TASK_CREATE once.",
          {
            owner_role: ownerRole,
            available_roles: roleScope.enabledAgents
          }
        );
      }
      if (task.parentTaskId && !run.tasks.some((item) => item.taskId === task.parentTaskId))
        throw new WorkflowRuntimeError(`parent task '${task.parentTaskId}' not found`, "TASK_NOT_FOUND", 404);
      const parentDependencies = task.parentTaskId
        ? (run.tasks.find((item) => item.taskId === task.parentTaskId)?.dependencies ?? [])
        : [];
      const explicitDependencies = (task.dependencies ?? [])
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      const dependencies = mergeDependencies(parentDependencies, explicitDependencies);
      for (const dep of dependencies)
        if (!run.tasks.some((item) => item.taskId === dep))
          throw new WorkflowRuntimeError(`dependency task '${dep}' not found`, "TASK_NOT_FOUND", 404);
      const nextTasks = [
        ...run.tasks,
        {
          taskId,
          title: task.title.trim(),
          resolvedTitle: task.title.trim(),
          ownerRole,
          parentTaskId: task.parentTaskId?.trim() || undefined,
          dependencies,
          acceptance: (task.acceptance ?? []).map((item) => item.trim()).filter((item) => item.length > 0),
          artifacts: (task.artifacts ?? []).map((item) => item.trim()).filter((item) => item.length > 0),
          creatorRole: input.fromAgent?.trim() || undefined,
          creatorSessionId: input.fromSessionId?.trim() || undefined
        }
      ];
      runtime.transitionSeq += 1;
      runtime.tasks.push({
        taskId,
        state: "PLANNED",
        blockedBy: [],
        blockedReasons: [],
        lastTransitionAt: new Date().toISOString(),
        transitionCount: 1,
        transitions: [{ seq: runtime.transitionSeq, at: new Date().toISOString(), fromState: null, toState: "PLANNED" }]
      });
      const runWithNewTasks: WorkflowRunRecord = { ...run, tasks: nextTasks };
      this.reevaluateDependencyGate(runWithNewTasks, runtime);
      this.recomputeParentTaskStates(runWithNewTasks, runtime);
      await writeWorkflowRunTaskRuntimeState(this.dataRoot, runId, runtime);
      const updated = await patchWorkflowRun(this.dataRoot, runId, { runtime, tasks: nextTasks });
      appliedTaskIds.push(taskId);
      return {
        success: true,
        actionType,
        createdTaskId: taskId,
        partialApplied: false,
        appliedTaskIds,
        rejectedResults,
        snapshot: this.toSnapshot(updated, runtime)
      };
    }

    if (actionType !== "TASK_REPORT") {
      throw new WorkflowRuntimeError(`unsupported action_type '${actionType}'`, "INVALID_TRANSITION", 400);
    }
    if (run.status !== "running") throw new WorkflowRuntimeError("run is not running", "RUN_NOT_RUNNING", 409);
    const predictedStateByTaskId = new Map(runtime.tasks.map((item) => [item.taskId, item.state]));
    for (const result of input.results ?? []) {
      const taskDef = runTaskById.get(result.taskId);
      const runtimeTask = byTask.get(result.taskId);
      if (!taskDef || !runtimeTask) {
        continue;
      }
      const target = this.parseOutcome(result.outcome);
      if (!target) {
        continue;
      }
      if (fromAgent !== "manager" && taskDef.ownerRole !== fromAgent) {
        continue;
      }
      const currentState = predictedStateByTaskId.get(result.taskId) ?? runtimeTask.state;
      if (!REPORTABLE_STATES.has(currentState)) {
        continue;
      }
      if (target !== "BLOCKED_DEP" && target !== "CANCELED") {
        const unresolvedDependencyTaskIds = this.resolveUnreadyDependencyTaskIds(
          taskDef,
          byTask,
          predictedStateByTaskId
        );
        if (unresolvedDependencyTaskIds.length > 0) {
          const hint =
            `Task '${result.taskId}' is blocked by dependencies [${unresolvedDependencyTaskIds.join(", ")}]. ` +
            "Wait until they are DONE/CANCELED before reporting IN_PROGRESS/DONE/MAY_BE_DONE. " +
            "If you already wrote conflicting completion claims, retract or downgrade them to draft until dependencies are ready.";
          throw new WorkflowRuntimeError(
            `task '${result.taskId}' cannot transition to '${target}' before dependencies are ready: ${unresolvedDependencyTaskIds.join(", ")}`,
            "TASK_DEPENDENCY_NOT_READY",
            409,
            hint,
            {
              task_id: result.taskId,
              dependency_task_ids: unresolvedDependencyTaskIds,
              current_state: currentState,
              reported_target_state: target,
              focus_task_id: input.taskId ?? null
            }
          );
        }
      }
      predictedStateByTaskId.set(result.taskId, target);
    }
    for (const result of input.results ?? []) {
      const task = byTask.get(result.taskId);
      if (!task) {
        rejectedResults.push({
          taskId: result.taskId,
          reasonCode: "TASK_NOT_FOUND",
          reason: `task '${result.taskId}' not found`
        });
        continue;
      }
      const taskDef = runTaskById.get(result.taskId);
      if (taskDef && fromAgent !== "manager" && taskDef.ownerRole !== fromAgent) {
        rejectedResults.push({
          taskId: result.taskId,
          reasonCode: "INVALID_TRANSITION",
          reason: `task '${result.taskId}' is owned by '${taskDef.ownerRole}', but report was submitted by '${fromAgent}'`
        });
        continue;
      }
      if (!REPORTABLE_STATES.has(task.state)) {
        rejectedResults.push({
          taskId: result.taskId,
          reasonCode: "TASK_ALREADY_TERMINAL",
          reason: `task '${result.taskId}' already terminal (${task.state})`
        });
        continue;
      }
      const target = this.parseOutcome(result.outcome);
      if (!target) {
        rejectedResults.push({
          taskId: result.taskId,
          reasonCode: "INVALID_TRANSITION",
          reason: `invalid outcome '${result.outcome}'`
        });
        continue;
      }
      if (target === "BLOCKED_DEP") {
        const blockers = (result.blockers ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
        task.blockedBy = blockers;
        task.blockers = blockers.length > 0 ? blockers : undefined;
        task.blockedReasons = blockers.length > 0 ? [{ code: "DEP_UNSATISFIED", dependencyTaskIds: blockers }] : [];
      } else {
        task.blockedBy = [];
        task.blockers = undefined;
        task.blockedReasons = [];
      }
      this.addTransition(runtime, task, target, result.summary);
      appliedTaskIds.push(result.taskId);
      if (input.fromSessionId) {
        await touchWorkflowSession(this.dataRoot, runId, input.fromSessionId, {
          status: target === "DONE" || target === "CANCELED" ? "idle" : "running",
          currentTaskId: target === "DONE" || target === "CANCELED" ? null : result.taskId
        }).catch(() => {});
      }
    }
    this.reevaluateDependencyGate(run, runtime);
    this.recomputeParentTaskStates(run, runtime);
    const now = new Date().toISOString();
    await writeWorkflowRunTaskRuntimeState(this.dataRoot, runId, runtime);
    const updated = await patchWorkflowRun(this.dataRoot, runId, {
      runtime,
      lastHeartbeatAt: now
    });
    await appendWorkflowRunEvent(this.dataRoot, runId, {
      eventType: "TASK_REPORT_APPLIED",
      source: fromAgent === "manager" ? "manager" : "agent",
      sessionId: input.fromSessionId,
      taskId: input.taskId,
      payload: {
        fromAgent,
        actionType,
        appliedTaskIds,
        updatedTaskIds: appliedTaskIds,
        rejectedCount: rejectedResults.length
      }
    });
    return {
      success: true,
      actionType,
      partialApplied: rejectedResults.length > 0,
      appliedTaskIds,
      rejectedResults,
      snapshot: this.toSnapshot(updated, runtime)
    };
  }

  async getRunOrchestratorSettings(runId: string): Promise<WorkflowRunOrchestratorSettings> {
    const run = await this.loadRunOrThrow(runId);
    return {
      run_id: run.runId,
      auto_dispatch_enabled: run.autoDispatchEnabled ?? true,
      auto_dispatch_remaining: Math.max(0, Math.floor(run.autoDispatchRemaining ?? 5)),
      hold_enabled: Boolean(run.holdEnabled),
      reminder_mode: normalizeReminderMode(run.reminderMode),
      updated_at: run.updatedAt
    };
  }

  async patchRunOrchestratorSettings(
    runId: string,
    patch: {
      autoDispatchEnabled?: boolean;
      autoDispatchRemaining?: number;
      holdEnabled?: boolean;
      reminderMode?: ReminderMode;
    }
  ): Promise<WorkflowRunOrchestratorSettings> {
    const updated = await patchWorkflowRun(this.dataRoot, runId, patch);
    return {
      run_id: updated.runId,
      auto_dispatch_enabled: updated.autoDispatchEnabled ?? true,
      auto_dispatch_remaining: Math.max(0, Math.floor(updated.autoDispatchRemaining ?? 5)),
      hold_enabled: Boolean(updated.holdEnabled),
      reminder_mode: normalizeReminderMode(updated.reminderMode),
      updated_at: updated.updatedAt
    };
  }

  async dispatchRun(
    runId: string,
    input: {
      role?: string;
      taskId?: string;
      force?: boolean;
      onlyIdle?: boolean;
      maxDispatches?: number;
      source?: "manual" | "loop";
    } = {}
  ): Promise<WorkflowDispatchResult> {
    const run = await this.loadRunOrThrow(runId);
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (run.status !== "running") {
      await appendWorkflowRunEvent(this.dataRoot, runId, {
        eventType: "ORCHESTRATOR_DISPATCH_FAILED",
        source: "system",
        payload: { requestId, error: "run_not_running" }
      });
      return {
        runId,
        results: [
          {
            role: input.role ?? "any",
            sessionId: null,
            taskId: input.taskId ?? null,
            outcome: "run_not_running",
            reason: "run is not running"
          }
        ],
        dispatchedCount: 0,
        remainingBudget: Math.max(0, Math.floor(run.autoDispatchRemaining ?? 5))
      };
    }
    if (run.holdEnabled && input.source === "loop") {
      return {
        runId,
        results: [
          {
            role: input.role ?? "any",
            sessionId: null,
            taskId: input.taskId ?? null,
            outcome: "invalid_target",
            reason: "run is on hold"
          }
        ],
        dispatchedCount: 0,
        remainingBudget: Math.max(0, Math.floor(run.autoDispatchRemaining ?? 5))
      };
    }

    const runtime = await this.ensureRuntime(run);
    const role = input.role?.trim();
    const taskFilter = input.taskId?.trim();
    const force = Boolean(input.force);
    const onlyIdle = Boolean(input.onlyIdle);
    const maxDispatchesRaw = Number(input.maxDispatches ?? 1);
    const maxDispatches = Number.isFinite(maxDispatchesRaw) && maxDispatchesRaw > 0 ? Math.floor(maxDispatchesRaw) : 1;
    const sessionList = await listWorkflowSessions(this.dataRoot, runId);
    const lockedSessionKeys = new Set<string>();
    let remaining = Math.max(0, Math.floor(run.autoDispatchRemaining ?? 5));
    const results: WorkflowDispatchResult["results"] = [];
    let dispatchedCount = 0;
    try {
      for (let i = 0; i < maxDispatches; i += 1) {
        if (!force && this.inFlightDispatchSessionKeys.size >= this.options.maxConcurrentDispatches) {
          if (results.length === 0) {
            results.push({
              role: role ?? "any",
              sessionId: null,
              taskId: taskFilter ?? null,
              outcome: "session_busy",
              reason: "max concurrent dispatches reached"
            });
          }
          break;
        }
        const roleSet = new Set<string>();
        for (const task of run.tasks) roleSet.add(task.ownerRole);
        for (const s of sessionList) if (s.status !== "dismissed") roleSet.add(s.role);
        for (const mappedRole of Object.keys(run.roleSessionMap ?? {})) roleSet.add(mappedRole);
        if (role) {
          roleSet.clear();
          roleSet.add(role);
        }

        let chosen:
          | {
              role: string;
              session: WorkflowSessionRecord;
              taskId: string | null;
              dispatchKind: "task" | "message";
              message: WorkflowManagerToAgentMessage | null;
              runtimeTask: WorkflowTaskRuntimeRecord | null;
            }
          | undefined;
        let busyFound = false;

        for (const roleCandidate of Array.from(roleSet).sort((a, b) => a.localeCompare(b))) {
          const session = await this.resolveAuthoritativeSession(runId, roleCandidate, sessionList, run, "dispatch");
          if (!session) {
            continue;
          }
          const sessionKey = this.buildRunSessionKey(runId, session.sessionId);
          if (
            (onlyIdle && session.status !== "idle") ||
            (!force && (session.status === "running" || this.inFlightDispatchSessionKeys.has(sessionKey)))
          ) {
            busyFound = true;
            continue;
          }
          if (!force && session.cooldownUntil && parseIsoMs(session.cooldownUntil) > Date.now()) {
            busyFound = true;
            continue;
          }
          const messages = sortMessagesByTime(
            await listWorkflowInboxMessages(this.dataRoot, runId, roleCandidate)
          ).filter((message) => {
            if (!taskFilter) {
              return true;
            }
            return (extractTaskIdFromMessage(message) ?? "") === taskFilter;
          });
          const roleTasks = run.tasks
            .filter((task) => task.ownerRole === roleCandidate)
            .filter((task) => !taskFilter || task.taskId === taskFilter)
            .map((task) => {
              const runtimeTask = runtime.tasks.find((item) => item.taskId === task.taskId);
              if (!runtimeTask) {
                return null;
              }
              return {
                taskId: task.taskId,
                state: runtimeTask.state,
                createdAt: runtimeTask.lastTransitionAt ?? run.createdAt
              };
            })
            .filter((item): item is { taskId: string; state: WorkflowTaskState; createdAt: string } => item !== null);
          const runnableRoleTasks = roleTasks.filter(
            (task) =>
              task.state === "READY" ||
              (force &&
                taskFilter === task.taskId &&
                (task.state === "DISPATCHED" || task.state === "IN_PROGRESS" || task.state === "MAY_BE_DONE"))
          );
          const selection = selectTaskForDispatch(messages, runnableRoleTasks, roleTasks);
          if (!selection) {
            const fallbackTask = runnableRoleTasks[0] ?? null;
            if (!fallbackTask) {
              continue;
            }
            chosen = {
              role: roleCandidate,
              session,
              taskId: fallbackTask.taskId,
              dispatchKind: "task",
              message: null,
              runtimeTask: runtime.tasks.find((item) => item.taskId === fallbackTask.taskId) ?? null
            };
            if (!chosen.runtimeTask) {
              chosen = undefined;
              continue;
            }
            break;
          }
          const selectedMessage = selection.messages[0] ?? null;
          const selectedTaskId = selection.taskId.length > 0 ? selection.taskId : null;
          const selectedRuntimeTask = selectedTaskId
            ? (runtime.tasks.find((item) => item.taskId === selectedTaskId) ?? null)
            : null;
          if (selection.dispatchKind === "task" && !selectedRuntimeTask) {
            continue;
          }
          if (selection.dispatchKind === "message" && !selectedMessage) {
            continue;
          }
          chosen = {
            role: roleCandidate,
            session,
            taskId: selectedTaskId,
            dispatchKind: selection.dispatchKind,
            message: selectedMessage,
            runtimeTask: selectedRuntimeTask
          };
          break;
        }

        if (!chosen) {
          if (results.length === 0) {
            results.push({
              role: role ?? "any",
              sessionId: null,
              taskId: taskFilter ?? null,
              outcome: busyFound ? "session_busy" : "no_task",
              reason: busyFound ? "session busy" : undefined
            });
          }
          break;
        }

        if (!force && (run.autoDispatchEnabled ?? true) && chosen.dispatchKind === "task" && remaining <= 0) {
          results.push({
            role: chosen.role,
            sessionId: chosen.session.sessionId,
            taskId: chosen.taskId,
            outcome: "invalid_target",
            reason: "auto dispatch budget exhausted"
          });
          break;
        }

        if (!force && chosen.dispatchKind === "task" && chosen.taskId) {
          const dispatchEvents = await listWorkflowRunEvents(this.dataRoot, runId);
          if (hasOpenTaskDispatch(dispatchEvents, chosen.taskId, chosen.session.sessionId)) {
            await appendWorkflowRunEvent(this.dataRoot, runId, {
              eventType: "ORCHESTRATOR_DISPATCH_SKIPPED",
              source: "system",
              sessionId: chosen.session.sessionId,
              taskId: chosen.taskId,
              payload: {
                requestId,
                dispatchKind: chosen.dispatchKind,
                dispatchSkipReason: "duplicate_open_dispatch"
              }
            });
            results.push({
              role: chosen.role,
              sessionId: chosen.session.sessionId,
              taskId: chosen.taskId,
              dispatchKind: chosen.dispatchKind,
              requestId,
              outcome: "already_dispatched",
              reason: "duplicate_open_dispatch"
            });
            break;
          }
        }

        const sessionKey = this.buildRunSessionKey(runId, chosen.session.sessionId);
        this.inFlightDispatchSessionKeys.add(sessionKey);
        lockedSessionKeys.add(sessionKey);
        const dispatchId = randomUUID();
        const messageId = chosen.message?.envelope.message_id;
        if (chosen.dispatchKind === "task" && chosen.runtimeTask) {
          this.addTransition(runtime, chosen.runtimeTask, "DISPATCHED", "dispatched");
        }
        await touchWorkflowSession(this.dataRoot, runId, chosen.session.sessionId, {
          status: "running",
          currentTaskId: chosen.taskId,
          lastDispatchedAt: new Date().toISOString(),
          lastDispatchId: dispatchId,
          lastDispatchedMessageId: messageId ?? null
        }).catch(() => {});
        chosen.session.status = "running";
        chosen.session.currentTaskId = chosen.taskId ?? undefined;
        chosen.session.lastDispatchId = dispatchId;
        if (chosen.dispatchKind === "message" && chosen.message) {
          await removeWorkflowInboxMessages(this.dataRoot, runId, chosen.role, [chosen.message.envelope.message_id]);
        }
        if (!force && (run.autoDispatchEnabled ?? true) && chosen.dispatchKind === "task") {
          remaining = Math.max(0, remaining - 1);
        }
        results.push({
          role: chosen.role,
          sessionId: chosen.session.sessionId,
          taskId: chosen.taskId,
          dispatchKind: chosen.dispatchKind,
          messageId,
          requestId,
          outcome: "dispatched"
        });
        dispatchedCount += 1;
        void this.launchMiniMaxDispatch({
          run,
          session: chosen.session,
          role: chosen.role,
          dispatchKind: chosen.dispatchKind,
          taskId: chosen.taskId,
          message: chosen.message,
          requestId,
          messageId,
          dispatchId
        }).catch((error) => {
          logger.error(
            `[workflow-orchestrator] launchMiniMaxDispatch failed: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      }
      if (results.length === 0) {
        results.push({ role: role ?? "any", sessionId: null, taskId: taskFilter ?? null, outcome: "no_task" });
      }
      await writeWorkflowRunTaskRuntimeState(this.dataRoot, runId, runtime);
      await patchWorkflowRun(this.dataRoot, runId, {
        runtime,
        autoDispatchRemaining: remaining,
        lastHeartbeatAt: new Date().toISOString()
      });
      return { runId, results, dispatchedCount, remainingBudget: remaining };
    } finally {
      for (const key of lockedSessionKeys) {
        this.inFlightDispatchSessionKeys.delete(key);
      }
    }
  }

  async getStatus(): Promise<WorkflowOrchestratorStatus> {
    const loop = this.loopCore.getSnapshot();
    const activeRunIds = Array.from(this.activeRunIds).sort((a, b) => a.localeCompare(b));
    const runs = await listWorkflowRuns(this.dataRoot);
    return {
      enabled: loop.enabled,
      running: loop.running,
      intervalMs: loop.intervalMs,
      maxConcurrentDispatches: this.options.maxConcurrentDispatches,
      inFlightDispatchSessions: this.inFlightDispatchSessionKeys.size,
      lastTickAt: loop.lastTickAt,
      started: loop.started,
      activeRunIds,
      activeRunCount: activeRunIds.length,
      runs: runs.map((item) => ({
        runId: item.runId,
        autoDispatchEnabled: item.autoDispatchEnabled ?? true,
        autoDispatchRemaining: Math.max(0, Math.floor(item.autoDispatchRemaining ?? 5)),
        holdEnabled: Boolean(item.holdEnabled),
        reminderMode: normalizeReminderMode(item.reminderMode)
      }))
    };
  }
}

export function createWorkflowOrchestratorService(dataRoot: string): WorkflowOrchestratorService {
  const enabled =
    String(process.env.WORKFLOW_ORCHESTRATOR_ENABLED ?? process.env.ORCHESTRATOR_ENABLED ?? "1").trim() !== "0";
  const intervalRaw = Number(
    process.env.WORKFLOW_ORCHESTRATOR_INTERVAL_MS ?? process.env.ORCHESTRATOR_INTERVAL_MS ?? 10000
  );
  const intervalMs = Number.isFinite(intervalRaw) && intervalRaw > 500 ? Math.floor(intervalRaw) : 10000;
  const maxConcurrentDispatchRaw = Number(
    process.env.WORKFLOW_ORCHESTRATOR_MAX_CONCURRENT_SESSIONS ?? process.env.ORCHESTRATOR_MAX_CONCURRENT_SESSIONS ?? 2
  );
  const maxConcurrentDispatches =
    Number.isFinite(maxConcurrentDispatchRaw) && maxConcurrentDispatchRaw > 0
      ? Math.floor(maxConcurrentDispatchRaw)
      : 2;
  const idleTimeoutRaw = Number(
    process.env.WORKFLOW_ORCHESTRATOR_IDLE_TIMEOUT_MS ?? process.env.ORCHESTRATOR_IDLE_TIMEOUT_MS ?? 60000
  );
  const idleReminderMs = Number.isFinite(idleTimeoutRaw) && idleTimeoutRaw > 0 ? Math.floor(idleTimeoutRaw) : 60000;
  const backoffRaw = Number(
    process.env.WORKFLOW_ORCHESTRATOR_REMINDER_BACKOFF_MULTIPLIER ??
      process.env.ORCHESTRATOR_REMINDER_BACKOFF_MULTIPLIER ??
      2
  );
  const reminderBackoffMultiplier = Number.isFinite(backoffRaw) && backoffRaw > 1 ? backoffRaw : 2;
  const maxIntervalRaw = Number(
    process.env.WORKFLOW_ORCHESTRATOR_REMINDER_MAX_INTERVAL_MS ??
      process.env.ORCHESTRATOR_REMINDER_MAX_INTERVAL_MS ??
      1800000
  );
  const reminderMaxIntervalMs =
    Number.isFinite(maxIntervalRaw) && maxIntervalRaw > 0 ? Math.floor(maxIntervalRaw) : 1800000;
  const reminderMaxCountRaw = Number(
    process.env.WORKFLOW_ORCHESTRATOR_REMINDER_MAX_COUNT ?? process.env.ORCHESTRATOR_REMINDER_MAX_COUNT ?? 5
  );
  const reminderMaxCount =
    Number.isFinite(reminderMaxCountRaw) && reminderMaxCountRaw >= 0 ? Math.floor(reminderMaxCountRaw) : 5;
  const autoReminderEnabled =
    String(
      process.env.WORKFLOW_ORCHESTRATOR_AUTO_REMINDER_ENABLED ?? process.env.ORCHESTRATOR_AUTO_REMINDER_ENABLED ?? "1"
    ).trim() !== "0";
  const sessionTimeoutRaw = Number(
    process.env.WORKFLOW_SESSION_RUNNING_TIMEOUT_MS ?? process.env.SESSION_RUNNING_TIMEOUT_MS ?? 60000
  );
  const sessionRunningTimeoutMs =
    Number.isFinite(sessionTimeoutRaw) && sessionTimeoutRaw > 0 ? Math.floor(sessionTimeoutRaw) : 60000;
  return new WorkflowOrchestratorService(dataRoot, {
    enabled,
    intervalMs,
    maxConcurrentDispatches,
    idleReminderMs,
    reminderBackoffMultiplier,
    reminderMaxIntervalMs,
    reminderMaxCount,
    autoReminderEnabled,
    sessionRunningTimeoutMs
  });
}
