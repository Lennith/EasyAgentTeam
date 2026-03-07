import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { listAgents } from "../data/agent-store.js";
import { getRuntimeSettings } from "../data/runtime-settings-store.js";
import {
  appendWorkflowInboxMessage,
  appendWorkflowRunEvent,
  getWorkflowSession,
  listWorkflowInboxMessages,
  listWorkflowSessions,
  readWorkflowRunTaskRuntimeState,
  removeWorkflowInboxMessages,
  touchWorkflowSession,
  upsertWorkflowSession,
  writeWorkflowRunTaskRuntimeState
} from "../data/workflow-run-store.js";
import { getWorkflowRun, listWorkflowRuns, patchWorkflowRun, WorkflowStoreError } from "../data/workflow-store.js";
import type {
  WorkflowBlockReasonCode,
  WorkflowManagerToAgentMessage,
  ReminderMode,
  WorkflowRunRecord,
  WorkflowRunRuntimeSnapshot,
  WorkflowRunRuntimeState,
  WorkflowRunState,
  WorkflowSessionRecord,
  WorkflowTaskActionRequest,
  WorkflowTaskActionResult,
  WorkflowTaskRuntimeRecord,
  WorkflowTaskState
} from "../domain/models.js";
import { createMiniMaxAgent } from "../minimax/index.js";
import { logger } from "../utils/logger.js";
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
import { getTimeoutCooldownMs, getTimeoutEscalationThreshold } from "./session-lifecycle-authority.js";
import {
  buildWorkflowTeamToolContext,
  createWorkflowMiniMaxTeamToolBridge
} from "./workflow-minimax-teamtool-bridge.js";

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
    outcome: "dispatched" | "no_task" | "session_busy" | "run_not_running" | "invalid_target";
    reason?: string;
  }>;
  dispatchedCount: number;
  remainingBudget: number;
}

export class WorkflowRuntimeError extends Error {
  constructor(
    message: string,
    public readonly code: WorkflowBlockReasonCode | "ROUTE_DENIED" | "MESSAGE_TARGET_REQUIRED",
    public readonly status: number = 400
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

interface RoleReminderState {
  idleSince?: string;
  reminderCount: number;
  nextReminderAt?: string;
  lastRoleState: "INACTIVE" | "IDLE" | "RUNNING";
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

function isTerminalState(state: WorkflowTaskState): boolean {
  return TERMINAL_STATES.has(state);
}

function buildSessionId(role: string): string {
  const safeRole = role.replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `session-${safeRole}-${randomUUID().slice(0, 12)}`;
}

function hasRoutePermission(run: WorkflowRunRecord, fromAgent: string, toRole: string): boolean {
  const table = run.routeTable;
  if (!table || Object.keys(table).length === 0) {
    return true;
  }
  return Array.isArray(table[fromAgent]) && table[fromAgent].includes(toRole);
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
    return Number.NaN;
  }
  return Date.parse(value);
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

export class WorkflowOrchestratorService {
  private readonly loopCore: OrchestratorLoopCore;
  private readonly activeRunIds = new Set<string>();
  private readonly inFlightDispatchSessionKeys = new Set<string>();
  private readonly roleReminderState = new Map<string, RoleReminderState>();
  private readonly runHoldState = new Map<string, boolean>();
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
    this.roleReminderState.clear();
    this.runHoldState.clear();
    this.sessionHeartbeatThrottle.clear();
  }

  private buildRunRoleKey(runId: string, role: string): string {
    return buildOrchestratorContextSessionKey(runId, role);
  }

  private buildRunSessionKey(runId: string, sessionId: string): string {
    return buildOrchestratorContextSessionKey(runId, sessionId);
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

  private async resolveAuthoritativeSession(
    runId: string,
    role: string,
    sessions: WorkflowSessionRecord[]
  ): Promise<WorkflowSessionRecord | null> {
    let session =
      [...sessions]
        .filter((item) => item.role === role && item.status !== "dismissed")
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;
    if (session) {
      return session;
    }
    const created = await upsertWorkflowSession(this.dataRoot, runId, {
      sessionId: buildSessionId(role),
      role,
      status: "idle",
      provider: "minimax"
    });
    sessions.push(created.session);
    return created.session;
  }

  private async touchSessionHeartbeat(runId: string, sessionId: string): Promise<void> {
    const key = this.buildRunSessionKey(runId, sessionId);
    const nowMs = Date.now();
    const last = this.sessionHeartbeatThrottle.get(key) ?? 0;
    if (nowMs - last < 1000) {
      return;
    }
    this.sessionHeartbeatThrottle.set(key, nowMs);
    await touchWorkflowSession(this.dataRoot, runId, sessionId, { status: "running" }).catch(() => {});
  }

  private buildDispatchPrompt(input: {
    run: WorkflowRunRecord;
    role: string;
    taskId: string | null;
    dispatchKind: "task" | "message";
    message: WorkflowManagerToAgentMessage | null;
    taskState: WorkflowTaskState | null;
    rolePrompt?: string;
  }): string {
    const messageType = input.message ? readMessageTypeUpper(input.message) : "TASK_ASSIGNMENT";
    const messageContent =
      input.message && typeof (input.message.body as Record<string, unknown>).content === "string"
        ? String((input.message.body as Record<string, unknown>).content)
        : "";
    const task = input.taskId ? input.run.tasks.find((item) => item.taskId === input.taskId) : null;
    const rolePrompt = input.rolePrompt?.trim() ?? "";
    return [
      `You are agent role '${input.role}' in workflow run '${input.run.runId}'.`,
      `Workflow objective: ${input.run.description ?? input.run.name}`,
      `Dispatch kind: ${input.dispatchKind}.`,
      `Assigned task id: ${input.taskId ?? "(none)"}`,
      `Current task state: ${input.taskState ?? "UNKNOWN"}`,
      `Message type: ${messageType}`,
      messageContent ? `Message content:\n${messageContent}` : "Message content: (none)",
      task
        ? `Task context:\n- title: ${task.resolvedTitle}\n- owner: ${task.ownerRole}\n- parent: ${task.parentTaskId ?? "(none)"}\n- dependencies: ${(task.dependencies ?? []).join(", ") || "(none)"}\n- acceptance: ${(task.acceptance ?? []).join(" | ") || "(none)"}\n- artifacts: ${(task.artifacts ?? []).join(", ") || "(none)"}`
        : "Task context: (none)",
      rolePrompt ? `Role system prompt:\n${rolePrompt}` : "",
      "Execution contract:",
      "1) Execute immediately and produce concrete progress/artifacts.",
      "2) Use workflow task actions via manager APIs only (TASK_CREATE/TASK_DISCUSS_*/TASK_REPORT).",
      "3) If blocked, report BLOCKED_DEP with concrete blockers.",
      "4) On completion, report DONE for the phase task, not only subtasks."
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
    const sessionKey = this.buildRunSessionKey(runId, input.session.sessionId);
    try {
      const settings = await getRuntimeSettings(this.dataRoot);
      if (!settings.minimaxApiKey) {
        await appendWorkflowRunEvent(this.dataRoot, runId, {
          eventType: "ORCHESTRATOR_DISPATCH_FAILED",
          source: "system",
          sessionId: input.session.sessionId,
          taskId: input.taskId ?? undefined,
          payload: {
            requestId: input.requestId,
            dispatchId: input.dispatchId,
            messageId: input.messageId ?? null,
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

      const agents = await listAgents(this.dataRoot);
      const rolePrompt = agents.find((item) => item.agentId === input.role)?.prompt;
      const runtime = await this.getRunTaskRuntime(runId);
      const runtimeTask = input.taskId ? (runtime.tasks.find((item) => item.taskId === input.taskId) ?? null) : null;
      const prompt = this.buildDispatchPrompt({
        run: input.run,
        role: input.role,
        taskId: input.taskId,
        dispatchKind: input.dispatchKind,
        message: input.message,
        taskState: runtimeTask?.state ?? null,
        rolePrompt
      });

      const agentWorkspaceDir = path.join(input.run.workspacePath, "Agents", input.role);
      await fs.mkdir(agentWorkspaceDir, { recursive: true });
      const providerSessionId = input.session.providerSessionId?.trim() || input.session.sessionId;
      const teamToolContext = buildWorkflowTeamToolContext({
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
      });
      const teamToolBridge = createWorkflowMiniMaxTeamToolBridge({
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
      });

      const agent = createMiniMaxAgent({
        config: {
          apiKey: settings.minimaxApiKey ?? "",
          apiBase: settings.minimaxApiBase ?? "https://api.minimax.io",
          model: settings.minimaxModel ?? "MiniMax-M2.5",
          workspaceDir: agentWorkspaceDir,
          sessionDir: settings.minimaxSessionDir ?? path.join(input.run.workspacePath, ".minimax", "sessions"),
          maxSteps: settings.minimaxMaxSteps ?? 200,
          tokenLimit: settings.minimaxTokenLimit ?? 180000,
          enableFileTools: true,
          enableShell: true,
          enableNote: true,
          shellType: "powershell",
          shellTimeout: settings.minimaxShellTimeout ?? 30000,
          shellOutputIdleTimeout: settings.minimaxShellOutputIdleTimeout ?? 60000,
          shellMaxRunTime: settings.minimaxShellMaxRunTime ?? 600000,
          shellMaxOutputSize: settings.minimaxShellMaxOutputSize ?? 52428800,
          mcpEnabled: (settings.minimaxMcpServers?.length ?? 0) > 0,
          mcpServers: settings.minimaxMcpServers ?? [],
          mcpConnectTimeout: 30000,
          mcpExecuteTimeout: 60000,
          additionalWritableDirs: [input.run.workspacePath],
          teamToolContext,
          teamToolBridge,
          env: {
            AUTO_DEV_WORKFLOW_RUN_ID: runId,
            AUTO_DEV_SESSION_ID: input.session.sessionId,
            AUTO_DEV_AGENT_ROLE: input.role,
            AUTO_DEV_WORKFLOW_ROOT: input.run.workspacePath,
            AUTO_DEV_AGENT_WORKSPACE: agentWorkspaceDir,
            AUTO_DEV_MANAGER_URL: process.env.AUTO_DEV_MANAGER_URL ?? "http://127.0.0.1:43123"
          }
        }
      });

      await agent.runWithResult({
        prompt,
        sessionId: providerSessionId,
        callback: {
          onThinking: () => void this.touchSessionHeartbeat(runId, input.session.sessionId),
          onToolCall: () => void this.touchSessionHeartbeat(runId, input.session.sessionId),
          onToolResult: () => void this.touchSessionHeartbeat(runId, input.session.sessionId),
          onMessage: () => void this.touchSessionHeartbeat(runId, input.session.sessionId),
          onError: () => void this.touchSessionHeartbeat(runId, input.session.sessionId)
        }
      });

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
          messageId: input.messageId ?? null
        }
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
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
          error: reason
        }
      });
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
    } finally {
      this.inFlightDispatchSessionKeys.delete(sessionKey);
    }
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
    const openTasksByRole = new Map<string, number>();
    for (const task of run.tasks) {
      const runtimeTask = runtime.tasks.find((item) => item.taskId === task.taskId);
      if (!runtimeTask || !isRemindableTaskState(runtimeTask.state)) {
        continue;
      }
      openTasksByRole.set(task.ownerRole, (openTasksByRole.get(task.ownerRole) ?? 0) + 1);
    }

    for (const [role, openCount] of openTasksByRole.entries()) {
      const session = await this.resolveAuthoritativeSession(run.runId, role, sessions);
      const roleState = getRoleState(session);
      const key = this.buildRunRoleKey(run.runId, role);
      const previous = this.roleReminderState.get(key) ?? {
        reminderCount: 0,
        lastRoleState: "INACTIVE"
      };
      const next: RoleReminderState = { ...previous, lastRoleState: roleState };
      if (openCount <= 0 || roleState !== "IDLE" || !session) {
        next.reminderCount = 0;
        next.nextReminderAt = undefined;
        next.idleSince = undefined;
        this.roleReminderState.set(key, next);
        continue;
      }
      if (!next.idleSince) {
        next.idleSince = session.lastDispatchedAt ?? session.updatedAt;
      }
      if (!next.nextReminderAt) {
        next.nextReminderAt = calculateNextReminderTimeByMode(reminderMode, next.reminderCount, nowMs, {
          initialWaitMs: this.options.idleReminderMs,
          backoffMultiplier: this.options.reminderBackoffMultiplier,
          maxWaitMs: this.options.reminderMaxIntervalMs
        });
      }
      const nextReminderMs = parseIsoMs(next.nextReminderAt);
      if (
        next.reminderCount >= this.options.reminderMaxCount ||
        !Number.isFinite(nextReminderMs) ||
        nowMs < nextReminderMs
      ) {
        this.roleReminderState.set(key, next);
        continue;
      }

      const reminderMessageId = `reminder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const reminderRequestId = randomUUID();
      const content = `Reminder: you still have ${openCount} open task(s). Continue execution and report progress via TASK_REPORT.`;
      const message: WorkflowManagerToAgentMessage = {
        envelope: {
          message_id: reminderMessageId,
          run_id: run.runId,
          timestamp: new Date().toISOString(),
          sender: { type: "system", role: "manager", session_id: "manager-system" },
          via: { type: "manager" },
          intent: "MANAGER_MESSAGE",
          priority: "normal",
          correlation: { request_id: reminderRequestId, parent_request_id: reminderRequestId },
          accountability: {
            owner_role: role,
            report_to: { role: "manager", session_id: "manager-system" },
            expect: "TASK_REPORT"
          },
          dispatch_policy: "fixed_session"
        },
        body: { messageType: "MANAGER_MESSAGE", mode: "CHAT", content }
      };
      await appendWorkflowInboxMessage(this.dataRoot, run.runId, role, message);
      await appendWorkflowRunEvent(this.dataRoot, run.runId, {
        eventType: "ORCHESTRATOR_ROLE_REMINDER_TRIGGERED",
        source: "system",
        sessionId: session.sessionId,
        payload: {
          role,
          requestId: reminderRequestId,
          messageId: reminderMessageId,
          reminderMode,
          reminderCount: next.reminderCount,
          nextReminderAt: next.nextReminderAt
        }
      });

      next.reminderCount += 1;
      next.nextReminderAt = calculateNextReminderTimeByMode(reminderMode, next.reminderCount, nowMs, {
        initialWaitMs: this.options.idleReminderMs,
        backoffMultiplier: this.options.reminderBackoffMultiplier,
        maxWaitMs: this.options.reminderMaxIntervalMs
      });
      this.roleReminderState.set(key, next);
    }
  }

  private async markTimedOutSessions(run: WorkflowRunRecord, sessions: WorkflowSessionRecord[]): Promise<void> {
    const nowMs = Date.now();
    const threshold = getTimeoutEscalationThreshold();
    const cooldownMs = getTimeoutCooldownMs();
    for (const session of sessions) {
      if (session.status !== "running") {
        continue;
      }
      const inFlightKey = this.buildRunSessionKey(run.runId, session.sessionId);
      if (this.inFlightDispatchSessionKeys.has(inFlightKey)) {
        continue;
      }
      const lastActiveMs = parseIsoMs(session.lastActiveAt ?? session.updatedAt);
      if (!Number.isFinite(lastActiveMs)) {
        continue;
      }
      if (nowMs - lastActiveMs < this.options.sessionRunningTimeoutMs) {
        continue;
      }
      const timeoutStreak = (session.timeoutStreak ?? 0) + 1;
      const escalated = timeoutStreak >= threshold;
      const cooldownUntil =
        escalated || cooldownMs <= 0 ? null : new Date(Date.now() + Math.max(0, cooldownMs)).toISOString();
      await touchWorkflowSession(this.dataRoot, run.runId, session.sessionId, {
        status: escalated ? "dismissed" : "idle",
        timeoutStreak,
        lastFailureAt: new Date().toISOString(),
        lastFailureKind: "timeout",
        cooldownUntil,
        agentPid: null
      }).catch(() => {});
      await appendWorkflowRunEvent(this.dataRoot, run.runId, {
        eventType: "SESSION_HEARTBEAT_TIMEOUT",
        source: "system",
        sessionId: session.sessionId,
        taskId: session.currentTaskId,
        payload: {
          timeoutMs: this.options.sessionRunningTimeoutMs,
          lastActiveAt: session.lastActiveAt,
          timeoutStreak,
          threshold,
          escalated,
          cooldownUntil
        }
      });
      await appendWorkflowRunEvent(this.dataRoot, run.runId, {
        eventType: escalated ? "RUNNER_TIMEOUT_ESCALATED" : "RUNNER_TIMEOUT_SOFT",
        source: "system",
        sessionId: session.sessionId,
        taskId: session.currentTaskId,
        payload: {
          timeoutStreak,
          threshold,
          cooldownUntil
        }
      });
    }
  }

  private async tickLoop(): Promise<void> {
    const runs = await listWorkflowRuns(this.dataRoot);
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
        if (holdEnabled) {
          return;
        }
        await this.checkRoleReminders(run, runtime, sessions);

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
    const now = new Date().toISOString();
    const updated = await patchWorkflowRun(this.dataRoot, runId, {
      status: "stopped",
      stoppedAt: now,
      lastHeartbeatAt: now
    });
    this.activeRunIds.delete(runId);
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
    await this.loadRunOrThrow(runId);
    return upsertWorkflowSession(this.dataRoot, runId, {
      sessionId: input.sessionId?.trim() || buildSessionId(input.role),
      role: input.role,
      status: input.status,
      provider: input.provider,
      providerSessionId: input.providerSessionId
    });
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
      session =
        [...sessions]
          .filter((item) => item.role === toRole && item.status !== "dismissed")
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null;
      if (!session) {
        session = (
          await upsertWorkflowSession(this.dataRoot, input.runId, { sessionId: buildSessionId(toRole), role: toRole })
        ).session;
      }
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
      if (!taskId) throw new WorkflowRuntimeError("task.task_id is required", "INVALID_TRANSITION", 400);
      if (run.tasks.some((item) => item.taskId === taskId))
        throw new WorkflowRuntimeError(`task '${taskId}' already exists`, "INVALID_TRANSITION", 409);
      if (!task.title.trim() || !task.ownerRole.trim())
        throw new WorkflowRuntimeError("task.title and task.owner_role are required", "INVALID_TRANSITION", 400);
      if (task.parentTaskId && !run.tasks.some((item) => item.taskId === task.parentTaskId))
        throw new WorkflowRuntimeError(`parent task '${task.parentTaskId}' not found`, "TASK_NOT_FOUND", 404);
      const dependencies = (task.dependencies ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
      for (const dep of dependencies)
        if (!run.tasks.some((item) => item.taskId === dep))
          throw new WorkflowRuntimeError(`dependency task '${dep}' not found`, "TASK_NOT_FOUND", 404);
      const nextTasks = [
        ...run.tasks,
        {
          taskId,
          title: task.title.trim(),
          resolvedTitle: task.title.trim(),
          ownerRole: task.ownerRole.trim(),
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
    const now = new Date().toISOString();
    let nextStatus: WorkflowRunState = run.status;
    if (isRuntimeTerminal(runtime)) {
      nextStatus = "finished";
      this.activeRunIds.delete(runId);
    }
    await writeWorkflowRunTaskRuntimeState(this.dataRoot, runId, runtime);
    const updated = await patchWorkflowRun(this.dataRoot, runId, {
      runtime,
      status: nextStatus,
      lastHeartbeatAt: now,
      ...(nextStatus === "finished" ? { stoppedAt: now } : {})
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
    let remaining = Math.max(0, Math.floor(run.autoDispatchRemaining ?? 5));
    const results: WorkflowDispatchResult["results"] = [];
    let dispatchedCount = 0;

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
        const session = await this.resolveAuthoritativeSession(runId, roleCandidate, sessionList);
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

      const sessionKey = this.buildRunSessionKey(runId, chosen.session.sessionId);
      this.inFlightDispatchSessionKeys.add(sessionKey);
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
