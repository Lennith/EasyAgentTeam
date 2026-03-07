import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../utils/logger.js";
import type {
  ManagerToAgentMessage,
  ProjectPaths,
  ProjectRecord,
  RoleRuntimeState,
  SessionRecord,
  TaskRecord
} from "../domain/models.js";
import type { EventRecord } from "../domain/models.js";
import { appendEvent, listEvents } from "../data/event-store.js";
import { listAgents } from "../data/agent-store.js";
import { appendInboxMessage, listInboxMessages, removeInboxMessages } from "../data/inbox-store.js";
import { getRuntimeSettings } from "../data/runtime-settings-store.js";
import {
  ensureProjectRuntime,
  getProject,
  listProjects,
  setRoleSessionMapping,
  updateProjectOrchestratorSettings
} from "../data/project-store.js";
import { addSession, getSession, listSessions, touchSession } from "../data/session-store.js";
import { getTaskDependencyGateStatus, listRunnableTasksByRole, listTasks, patchTask } from "../data/taskboard-store.js";
import { runModelForProject } from "./codex-runner.js";
import {
  cancelMiniMaxRunner,
  isMiniMaxRunnerActive,
  startMiniMaxForProject,
  unregisterMiniMaxCompletionCallback,
  unregisterMiniMaxWakeUpCallback,
  type MiniMaxRunResultInternal
} from "./minimax-runner.js";
import { ensureProjectAgentScripts } from "./project-agent-script-service.js";
import { ensureAgentWorkspaces } from "./agent-workspace-service.js";
import { buildProjectRoutingSnapshot, type ProjectRoutingSnapshot } from "./project-routing-snapshot-service.js";
import {
  getRoleMessageStatus,
  addPendingMessagesForRole,
  confirmPendingMessagesForRole
} from "../data/role-message-status-store.js";
import { getRoleReminderState, updateRoleReminderState } from "../data/role-reminder-store.js";
import {
  markRunnerFatalError,
  markRunnerStarted,
  markRunnerSuccess,
  markRunnerTimeout,
  resolveActiveSessionForRole
} from "./session-lifecycle-authority.js";
import {
  extractTaskIdFromMessage,
  isRemindableTaskState,
  isDiscussMessage,
  readMessageTypeUpper,
  selectTaskForDispatch,
  sortMessagesByTime
} from "./orchestrator-dispatch-core.js";
import {
  buildOrchestratorContextSessionKey,
  OrchestratorLoopCore,
  runOrchestratorAdapterTick
} from "./orchestrator-core.js";

type DispatchMode = "manual" | "loop";

const MAY_BE_DONE_DISPATCH_THRESHOLD = 5;
const MAY_BE_DONE_CHECK_WINDOW_MS = 60 * 60 * 1000;

const INITIAL_REMINDER_WAIT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_REMINDER_WAIT_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Calculate next reminder time using exponential backoff
 * Formula: nextReminderAt = now + min(initialWaitMs * (backoffMultiplier ^ reminderCount), maxWaitMs)
 * @param reminderCount - Current reminder attempt count
 * @param nowMs - Current timestamp in ms (default: Date.now())
 * @param options - Optional config overrides
 */
export function calculateNextReminderTime(
  reminderCount: number,
  nowMs: number = Date.now(),
  options?: {
    initialWaitMs?: number;
    backoffMultiplier?: number;
    maxWaitMs?: number;
  }
): string {
  const initialWaitMs = options?.initialWaitMs ?? 60000; // Default: 1 minute
  const backoffMultiplier = options?.backoffMultiplier ?? 2;
  const maxWaitMs = options?.maxWaitMs ?? 1800000; // Default: 30 minutes
  const waitMs = Math.min(initialWaitMs * Math.pow(backoffMultiplier, reminderCount), maxWaitMs);
  return new Date(nowMs + waitMs).toISOString();
}

function calculateNextReminderTimeByMode(
  reminderMode: "backoff" | "fixed_interval",
  reminderCount: number,
  nowMs: number,
  options?: {
    initialWaitMs?: number;
    backoffMultiplier?: number;
    maxWaitMs?: number;
  }
): string {
  if (reminderMode === "fixed_interval") {
    const intervalMs = options?.initialWaitMs ?? 60000;
    return new Date(nowMs + intervalMs).toISOString();
  }
  return calculateNextReminderTime(reminderCount, nowMs, options);
}

function resolveRoleRuntimeState(roleSessions: SessionRecord[]): RoleRuntimeState {
  if (roleSessions.some((item) => item.status === "running")) {
    return "RUNNING";
  }
  if (roleSessions.some((item) => item.status === "idle")) {
    return "IDLE";
  }
  return "INACTIVE";
}

function resolveLatestIdleSession(roleSessions: SessionRecord[]): SessionRecord | undefined {
  return [...roleSessions]
    .filter((item) => item.status === "idle")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

export function shouldAutoResetReminderOnRoleTransition(
  previousState: RoleRuntimeState,
  currentState: RoleRuntimeState
): boolean {
  return previousState === "INACTIVE" && currentState === "IDLE";
}

type DispatchOutcome =
  | "dispatched"
  | "no_message"
  | "message_not_found"
  | "task_not_found"
  | "task_not_force_dispatchable"
  | "task_already_done"
  | "task_owner_mismatch"
  | "already_dispatched"
  | "session_busy"
  | "session_not_found"
  | "dispatch_failed";

type DispatchKind = "task" | "message" | null;

export interface SessionDispatchResult {
  sessionId: string;
  role: string;
  outcome: DispatchOutcome;
  dispatchKind: DispatchKind;
  reason?: string;
  messageId?: string;
  requestId?: string;
  runId?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  taskId?: string;
  sessionBootstrapped?: boolean;
  resolvedSessionId?: string;
}

export interface ProjectDispatchResult {
  projectId: string;
  mode: DispatchMode;
  results: SessionDispatchResult[];
}

interface DispatchProjectInput {
  sessionId?: string;
  messageId?: string;
  taskId?: string;
  force?: boolean;
  onlyIdle?: boolean;
  maxDispatches?: number;
  mode: DispatchMode;
}

interface OrchestratorOptions {
  dataRoot: string;
  enabled: boolean;
  intervalMs: number;
  maxConcurrentDispatches: number;
  sessionRunningTimeoutMs: number;
  // Reminder configuration
  idleTimeoutMs?: number; // Idle ms before first reminder (default: 60000 = 1 min)
  reminderBackoffMultiplier?: number; // Backoff multiplier (default: 2)
  reminderMaxIntervalMs?: number; // Max wait time (default: 1800000 = 30 min)
  reminderMaxCount?: number; // Max retry count (default: 5)
  autoReminderEnabled?: boolean; // Enable auto reminder (default: true)
}

function isPendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith("pending-");
}

function buildPendingSessionId(role: string): string {
  const safeRole = role.replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `session-${safeRole}-${randomUUID().slice(0, 12)}`;
}

function isForceDispatchableState(state: string): boolean {
  return state === "READY" || state === "DISPATCHED" || state === "IN_PROGRESS" || state === "MAY_BE_DONE";
}

function sessionMatchesOwnerToken(session: SessionRecord, ownerSessionToken: string | undefined): boolean {
  if (!ownerSessionToken) {
    return false;
  }
  return session.sessionId === ownerSessionToken;
}

function isTerminalTaskState(state: string): boolean {
  return state === "DONE" || state === "CANCELED";
}

/**
 * Check task dependency gate (self dependencies + ancestor-chain dependencies).
 */
function areTaskDependenciesSatisfied(
  task: TaskRecord,
  allTasks: TaskRecord[]
): {
  satisfied: boolean;
  unsatisfiedDeps: string[];
  blockingTaskIds: string[];
} {
  const byId = new Map(allTasks.map((item) => [item.taskId, item]));
  const gate = getTaskDependencyGateStatus(task, byId);
  return {
    satisfied: gate.satisfied,
    unsatisfiedDeps: gate.unsatisfiedDependencyIds,
    blockingTaskIds: gate.blockingTaskIds
  };
}

export type SessionProcessTerminationResultCode =
  | "killed"
  | "not_found"
  | "access_denied"
  | "failed"
  | "skipped_no_pid";

export interface SessionProcessTerminationResult {
  attempted: boolean;
  pid: number | null;
  result: SessionProcessTerminationResultCode;
  message: string;
}

function findCorrectTask(wrongTask: TaskRecord, targetRole: string, allTasks: TaskRecord[]): TaskRecord | null {
  const childTasks = allTasks.filter((t) => t.parentTaskId === wrongTask.taskId && t.state !== "CANCELED");

  const wrongOwner = wrongTask.ownerRole;
  const wrongCreator = wrongTask.creatorRole;

  for (const child of childTasks) {
    const childOwner = child.ownerRole;
    const childCreator = child.creatorRole;

    const ownerMatch = childOwner === wrongOwner || childOwner === wrongCreator;
    const creatorMatch = childCreator === wrongOwner || childCreator === wrongCreator;
    const different = childOwner !== childCreator;
    const targetMatch = childOwner === targetRole || childCreator === targetRole;

    if (ownerMatch && creatorMatch && different && targetMatch) {
      return child;
    }
  }

  return null;
}

export function resolveTaskDiscuss(
  message: ManagerToAgentMessage,
  targetRole: string,
  allTasks: TaskRecord[]
): ManagerToAgentMessage {
  if (!isDiscussMessage(message)) {
    return message;
  }

  const wrongTaskId = extractTaskIdFromMessage(message);
  if (!wrongTaskId) {
    return message;
  }

  const wrongTask = allTasks.find((t) => t.taskId === wrongTaskId);
  if (!wrongTask) {
    return message;
  }

  if (wrongTask.ownerRole === targetRole) {
    return message;
  }

  const correctTask = findCorrectTask(wrongTask, targetRole, allTasks);
  if (!correctTask) {
    return message;
  }

  logger.info(
    `[resolveTaskDiscuss] Mapping discuss taskId from '${wrongTaskId}' to '${correctTask.taskId}' for targetRole='${targetRole}'`
  );

  const body = message.body as Record<string, unknown>;
  return {
    ...message,
    body: {
      ...body,
      taskId: correctTask.taskId
    },
    envelope: {
      ...message.envelope,
      correlation: {
        ...message.envelope.correlation,
        task_id: correctTask.taskId
      }
    }
  };
}

function buildPromptFromMessages(
  project: ProjectRecord,
  session: SessionRecord,
  messages: ManagerToAgentMessage[],
  routingSnapshot: ProjectRoutingSnapshot,
  taskId: string
): string {
  const allowedTargets =
    routingSnapshot.allowedTargets.length > 0
      ? routingSnapshot.allowedTargets.map((item) => `${item.agentId}(max_rounds=${item.maxDiscussRounds})`).join(", ")
      : "(none)";
  const enabledAgents = routingSnapshot.enabledAgents.length > 0 ? routingSnapshot.enabledAgents.join(", ") : "(none)";

  const agentWorkspace = session.role ? `${project.workspacePath}/Agents/${session.role}` : project.workspacePath;

  const lines: string[] = [
    `You are role=${session.role}, session=${session.sessionId}.`,
    `TeamWorkSpace=${project.workspacePath} (shared project directory).`,
    `YourWorkspace=${agentWorkspace} (your personal working directory).`,
    "",
    "Runtime mode: static team rules are in local AGENTS.md.",
    "",
    "## Routing Snapshot",
    `from_agent_enabled=${routingSnapshot.fromAgentEnabled ? "true" : "false"}`,
    `enabled_agents=${enabledAgents}`,
    `allowed_targets=${allowedTargets}`,
    "",
    "## Incoming Messages",
    `task_id: ${taskId}`,
    `total_messages: ${messages.length}`,
    ""
  ];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgType = readMessageTypeUpper(msg);

    lines.push(`### Message ${i + 1} [${msgType}]`);

    if (isDiscussMessage(msg)) {
      const sender = msg.envelope.sender;
      const reportTo = msg.envelope.accountability?.report_to;
      lines.push(`from: ${sender?.role ?? "unknown"}`);
      if (reportTo) {
        lines.push(`reply_to: ${reportTo.role}`);
      }
      lines.push("");
    }

    lines.push("```json");
    lines.push(JSON.stringify(msg.body, null, 2));
    lines.push("```");
    lines.push("");
  }

  const discussMsgs = messages.filter((m) => isDiscussMessage(m));
  if (discussMsgs.length > 0) {
    lines.push("## Discuss Context");
    lines.push("");

    if (discussMsgs.length === 1) {
      const discussContext = extractDiscussContext(discussMsgs[0]);
      if (discussContext) {
        lines.push(`thread_id: ${discussContext.threadId}`);
        lines.push(`current_round: ${discussContext.round}`);
        lines.push(`max_rounds: ${discussContext.maxRounds}`);
        lines.push("");

        const reportTo = discussMsgs[0].envelope.accountability?.report_to;
        if (reportTo) {
          lines.push(`reply_to: ${reportTo.role}`);
        }
      }
    } else {
      lines.push("Multiple discuss threads detected. Check each message for thread_id and reply accordingly.");
      lines.push("");
      for (const msg of discussMsgs) {
        const discussContext = extractDiscussContext(msg);
        const reportTo = msg.envelope.accountability?.report_to;
        if (discussContext) {
          lines.push(
            `- thread_id: ${discussContext.threadId}, round: ${discussContext.round}/${discussContext.maxRounds}, reply_to: ${reportTo?.role ?? "unknown"}`
          );
        }
      }
    }
  }

  const discussMaxRoundsMap: Record<string, number> = {};
  for (const target of routingSnapshot.allowedTargets) {
    discussMaxRoundsMap[target.agentId] = target.maxDiscussRounds;
  }
  lines.push("");
  lines.push("## Discuss Tool Usage Guide");
  lines.push("When replying to a discuss message:");
  lines.push("- Find the thread_id from the message you want to reply to");
  lines.push("- Use round = current_round + 1 for your reply");
  lines.push("When starting a new discussion with another agent:");
  lines.push("- thread_id: Generate as `${taskId}-${timestamp}` or use existing thread");
  lines.push(`- max_rounds per target: ${JSON.stringify(discussMaxRoundsMap)}`);
  lines.push(
    "- if discuss is about task, read <YourWorkSpace>/progress.md and then use task_report_* ToolCalls when you make progress."
  );
  lines.push(
    "- discuss tool calls are `discuss_request`, `discuss_reply`, `discuss_close` (discussion only, not progress)."
  );
  lines.push(
    "- task report tool calls are `task_report_in_progress`, `task_report_done`, `task_report_block` (use these for progress/completion)."
  );

  return lines.join("\n");
}

function extractDiscussContext(message: ManagerToAgentMessage): {
  threadId: string;
  round: number;
  maxRounds: number;
} | null {
  const body = message.body as Record<string, unknown>;
  const discuss = body.discuss as Record<string, unknown> | undefined;

  if (!discuss) {
    const threadId = body.thread_id ?? body.threadId;
    if (threadId && typeof threadId === "string") {
      return {
        threadId,
        round: (body.round as number) ?? 1,
        maxRounds: (body.max_rounds as number) ?? (body.maxRounds as number) ?? 3
      };
    }
    return null;
  }

  const threadId = discuss.thread_id ?? discuss.threadId;
  if (!threadId || typeof threadId !== "string") return null;

  return {
    threadId,
    round: (discuss.round as number) ?? 1,
    maxRounds: (discuss.max_rounds as number) ?? (discuss.maxRounds as number) ?? 3
  };
}

function buildTaskAssignmentMessage(project: ProjectRecord, session: SessionRecord, task: any): ManagerToAgentMessage {
  const requestId = randomUUID();
  return {
    envelope: {
      message_id: randomUUID(),
      project_id: project.projectId,
      timestamp: new Date().toISOString(),
      sender: {
        type: "system",
        role: "manager",
        session_id: "manager-system"
      },
      via: { type: "manager" },
      intent: "TASK_ASSIGNMENT",
      priority: "normal",
      correlation: {
        request_id: requestId,
        task_id: task.taskId
      },
      accountability: {
        owner_role: session.role,
        report_to: { role: "manager", session_id: "manager-system" },
        expect: "TASK_REPORT"
      },
      dispatch_policy: "fixed_session"
    },
    body: {
      messageType: "TASK_ASSIGNMENT",
      mode: "CHAT",
      taskId: task.taskId,
      title: task.title,
      summary: task.lastSummary ?? "",
      task: {
        task_id: task.taskId,
        task_kind: task.taskKind,
        parent_task_id: task.parentTaskId,
        root_task_id: task.rootTaskId,
        state: task.state,
        owner_role: task.ownerRole,
        owner_session: task.ownerSession ?? null,
        priority: task.priority ?? 0,
        write_set: task.writeSet,
        dependencies: task.dependencies,
        acceptance: task.acceptance,
        artifacts: task.artifacts
      }
    }
  };
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function findLatestOpenDispatch(sessionEvents: EventRecord[]): { event: EventRecord; dispatchId: string } | null {
  const started = new Map<string, EventRecord>();
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

function hasOpenTaskDispatch(events: EventRecord[], taskId: string, sessionId: string): boolean {
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

function findLatestOpenRun(sessionEvents: EventRecord[]): { event: EventRecord; runId: string } | null {
  const started = new Map<string, EventRecord>();
  for (const event of sessionEvents) {
    const payload = event.payload as Record<string, unknown>;
    const runId = readPayloadString(payload, "runId");
    if (!runId) {
      continue;
    }
    if (event.eventType === "CODEX_RUN_STARTED" || event.eventType === "MINIMAX_RUN_STARTED") {
      started.set(runId, event);
      continue;
    }
    if (event.eventType === "CODEX_RUN_FINISHED" || event.eventType === "MINIMAX_RUN_FINISHED") {
      started.delete(runId);
    }
  }
  if (started.size === 0) {
    return null;
  }
  const latest = [...started.entries()].sort((a, b) => Date.parse(b[1].createdAt) - Date.parse(a[1].createdAt))[0];
  return {
    runId: latest[0],
    event: latest[1]
  };
}

function readPidFromEventPayload(payload: Record<string, unknown>): number | null {
  const raw = payload.pid;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

async function ensureRolePromptFile(project: ProjectRecord, role: string): Promise<void> {
  const roleFile = path.resolve(project.workspacePath, "Agents", role, "role.md");
  let content = "";
  try {
    content = await fs.readFile(roleFile, "utf8");
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") {
      throw new Error(`role.md missing for role=${role}`);
    }
    throw error;
  }
  if (!content.replace(/^\uFEFF/, "").trim()) {
    throw new Error(`role.md empty for role=${role}`);
  }
}

interface MiniMaxLauncherContext {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  session: SessionRecord;
  taskId: string;
  dispatchId: string;
  dispatchKind: "task" | "message" | null;
  selectedMessageIds: string[];
  firstMessage: ManagerToAgentMessage;
  startedAt: string;
  input: DispatchProjectInput;
  runId?: string;
}

async function handleMinMaxWakeUp(sessionId: string, runId: string, context: MiniMaxLauncherContext): Promise<void> {
  const { dataRoot, project, paths, session, taskId, dispatchId, dispatchKind, firstMessage } = context;
  if (context.runId && context.runId !== runId) {
    logger.warn(
      `[handleMinMaxWakeUp] ignored mismatched callback runId=${runId}, expected=${context.runId}, sessionId=${sessionId}`
    );
    return;
  }
  await confirmPendingMessagesForRole(paths, project.projectId, session.role);

  // mark task dispatched as soon as runner wakes up
  if (dispatchKind === "task" && taskId) {
    const allTasks = await listTasks(paths, project.projectId);
    const currentTask = allTasks.find((t) => t.taskId === taskId);
    if (currentTask) {
      const ACTIVE_STATES = new Set(["DISPATCHED", "IN_PROGRESS"]);
      const TERMINAL_STATES = new Set(["DONE", "CANCELED"]);
      if (!ACTIVE_STATES.has(currentTask.state) && !TERMINAL_STATES.has(currentTask.state)) {
        await patchTask(paths, project.projectId, taskId, {
          state: "DISPATCHED",
          grantedAt: new Date().toISOString()
        });
      }
    }
  }

  await markRunnerStarted({
    dataRoot,
    project,
    paths,
    sessionId: session.sessionId,
    taskId,
    messageId: dispatchKind === "message" ? firstMessage.envelope.message_id : undefined,
    runId,
    dispatchId,
    provider: "minimax"
  });
}

async function handleMiniMaxCompletion(
  result: MiniMaxRunResultInternal,
  sessionId: string,
  runId: string,
  context: MiniMaxLauncherContext
): Promise<void> {
  const {
    dataRoot,
    project,
    paths,
    session,
    taskId,
    dispatchId,
    dispatchKind,
    selectedMessageIds,
    firstMessage,
    startedAt,
    input
  } = context;
  if (context.runId && context.runId !== runId) {
    logger.warn(
      `[handleMiniMaxCompletion] ignored mismatched callback runId=${runId}, expected=${context.runId}, sessionId=${sessionId}`
    );
    return;
  }
  logger.info(
    `[handleMiniMaxCompletion] sessionId=${sessionId}, runId=${runId}, exitCode=${result.exitCode}, timedOut=${result.timedOut}`
  );
  await confirmPendingMessagesForRole(paths, project.projectId, session.role);

  let failedReason: string | null = null;
  if (result.timedOut) {
    const timeoutResult = await markRunnerTimeout({
      dataRoot,
      project,
      paths,
      sessionId,
      taskId,
      messageId: dispatchKind === "message" ? firstMessage.envelope.message_id : undefined,
      runId,
      dispatchId,
      provider: "minimax"
    });
    if (timeoutResult.escalated) {
      failedReason = "runner timeout escalated";
    }
  } else if (result.exitCode === 0) {
    await markRunnerSuccess({
      dataRoot,
      project,
      paths,
      sessionId,
      taskId,
      messageId: dispatchKind === "message" ? firstMessage.envelope.message_id : undefined,
      runId,
      dispatchId,
      providerSessionId: result.sessionId ?? null,
      provider: "minimax"
    });
  } else {
    failedReason = result.error ?? `runner exited with code ${result.exitCode}`;
    await markRunnerFatalError({
      dataRoot,
      project,
      paths,
      sessionId,
      taskId,
      messageId: dispatchKind === "message" ? firstMessage.envelope.message_id : undefined,
      runId,
      dispatchId,
      providerSessionId: result.sessionId ?? null,
      provider: "minimax",
      error: failedReason
    });
  }

  if (failedReason) {
    await appendEvent(paths, {
      projectId: project.projectId,
      eventType: "ORCHESTRATOR_DISPATCH_FAILED",
      source: "manager",
      sessionId,
      taskId,
      payload: {
        dispatchId,
        mode: input.mode,
        dispatchKind,
        messageIds: selectedMessageIds,
        requestId: firstMessage.envelope.correlation.request_id,
        runId,
        error: failedReason
      }
    });
  } else {
    await appendEvent(paths, {
      projectId: project.projectId,
      eventType: "ORCHESTRATOR_DISPATCH_FINISHED",
      source: "manager",
      sessionId,
      taskId,
      payload: {
        dispatchId,
        mode: input.mode,
        dispatchKind,
        messageIds: selectedMessageIds,
        requestId: firstMessage.envelope.correlation.request_id,
        runId,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        startedAt,
        finishedAt: result.finishedAt
      }
    });
  }

  logger.info(`[handleMiniMaxCompletion] sessionId=${sessionId}, runId=${runId}, failed=${failedReason !== null}`);
}

const TERMINAL_TASK_STATES = new Set(["DONE", "CANCELED"]);

async function cleanupCompletedTaskMessages(paths: ProjectPaths, projectId: string, role: string): Promise<number> {
  const allTasks = await listTasks(paths, projectId);
  const inboxMessages = await listInboxMessages(paths, role);

  const messagesToRemove: string[] = [];

  for (const msg of inboxMessages) {
    const taskId = extractTaskIdFromMessage(msg);
    if (taskId) {
      const task = allTasks.find((t) => t.taskId === taskId);
      if (task && TERMINAL_TASK_STATES.has(task.state)) {
        messagesToRemove.push(msg.envelope.message_id);
      }
    }
  }

  if (messagesToRemove.length > 0) {
    const removed = await removeInboxMessages(paths, role, messagesToRemove);
    logger.info(
      `[cleanupCompletedTaskMessages] projectId=${projectId}, role=${role}, removed ${removed} messages for completed/canceled tasks`
    );
    return removed;
  }
  return 0;
}

async function dispatchSessionOnce(
  dataRoot: string,
  project: ProjectRecord,
  paths: ProjectPaths,
  session: SessionRecord,
  input: DispatchProjectInput,
  rolePromptMap: Map<string, string>,
  registeredAgentIds: string[]
): Promise<SessionDispatchResult> {
  await cleanupCompletedTaskMessages(paths, project.projectId, session.role);

  const inboxMessages = await listInboxMessages(paths, session.role);
  const explicitMessageCandidate = input.messageId
    ? inboxMessages.find((item) => item.envelope.message_id === input.messageId)
    : null;

  const roleStatus = getRoleMessageStatus(project, session.role);
  const confirmedIds = new Set(roleStatus.confirmedMessageIds);
  const pendingIds = new Set(roleStatus.pendingConfirmedMessages.map((p) => p.messageId));
  const undeliveredMessages = input.messageId
    ? []
    : inboxMessages
        .filter((item) => !confirmedIds.has(item.envelope.message_id) && !pendingIds.has(item.envelope.message_id))
        .sort((a, b) => {
          const aTime = a.envelope.timestamp ? new Date(a.envelope.timestamp).getTime() : 0;
          const bTime = b.envelope.timestamp ? new Date(b.envelope.timestamp).getTime() : 0;
          return aTime - bTime;
        });

  if (inboxMessages.length > 0) {
    const sampleFiltered = inboxMessages.slice(0, 3).map((item) => ({
      id: item.envelope.message_id,
      confirmed: confirmedIds.has(item.envelope.message_id),
      pending: pendingIds.has(item.envelope.message_id)
    }));
    logger.info(
      `[dispatchSessionOnce] sessionId=${session.sessionId}, role=${session.role}, inbox sample (first 3): ${JSON.stringify(sampleFiltered)}`
    );
  }

  logger.info(
    `[dispatchSessionOnce] sessionId=${session.sessionId}, role=${session.role}, inboxCount=${inboxMessages.length}, confirmedCount=${confirmedIds.size}, pendingCount=${pendingIds.size}, undeliveredCount=${undeliveredMessages.length}`
  );

  const runnableByRole = await listRunnableTasksByRole(paths, project.projectId);
  const runnableTasks = runnableByRole.find((item) => item.role === session.role)?.tasks ?? [];
  // [DEBUG] Keep verbose state logs to diagnose why runnableTasks can be empty.
  const allTasks = await listTasks(paths, project.projectId);
  const tasksByState = allTasks.reduce(
    (acc, task) => {
      acc[task.state] = (acc[task.state] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );
  logger.info(
    `[dispatchSessionOnce] sessionId=${session.sessionId}, role=${session.role}, tasksByState=${JSON.stringify(tasksByState)}, runnableByRole=${JSON.stringify(runnableByRole.map((r) => ({ role: r.role, taskCount: r.tasks.length, taskIds: r.tasks.map((t) => t.taskId) })))}, runnableTasks=${runnableTasks.length}`
  );

  let selectedMessages: ManagerToAgentMessage[] = [];
  let selectedTaskId = "";
  let dispatchKind: DispatchKind = null;

  if (explicitMessageCandidate) {
    selectedMessages = [explicitMessageCandidate];
    selectedTaskId = extractTaskIdFromMessage(explicitMessageCandidate) ?? "";
    dispatchKind = "message";
  } else {
    const selection = selectTaskForDispatch(undeliveredMessages, runnableTasks, allTasks);
    if (selection) {
      selectedMessages = selection.messages;
      selectedTaskId = selection.taskId;
      dispatchKind = selection.dispatchKind;
    } else {
      let taskCandidate: TaskRecord | null = null;
      if (!input.force) {
        taskCandidate = runnableTasks.find((t) => t.state !== "MAY_BE_DONE") ?? null;
      } else {
        taskCandidate = runnableTasks.length > 0 ? runnableTasks[0] : null;
      }
      if (input.taskId) {
        const allTasks = await listTasks(paths, project.projectId);
        const targetTask = allTasks.find((t) => t.taskId === input.taskId);
        if (!targetTask) {
          return {
            sessionId: session.sessionId,
            role: session.role,
            outcome: "task_not_found",
            dispatchKind: "task",
            taskId: input.taskId,
            reason: `task '${input.taskId}' does not exist (hint: refresh task-tree and retry with current task_id)`
          };
        }

        if (targetTask.state === "DONE") {
          return {
            sessionId: session.sessionId,
            role: session.role,
            outcome: "task_already_done",
            dispatchKind: "task",
            taskId: input.taskId,
            reason: `task '${input.taskId}' is already DONE`
          };
        }

        if (input.force) {
          if (!isForceDispatchableState(targetTask.state)) {
            return {
              sessionId: session.sessionId,
              role: session.role,
              outcome: "task_not_force_dispatchable",
              dispatchKind: "task",
              taskId: input.taskId,
              reason: `task '${input.taskId}' state=${targetTask.state} is not force-dispatchable`
            };
          }
          if (session.role !== targetTask.ownerRole) {
            return {
              sessionId: session.sessionId,
              role: session.role,
              outcome: "task_owner_mismatch",
              dispatchKind: "task",
              taskId: input.taskId,
              reason: `task '${input.taskId}' belongs to role '${targetTask.ownerRole}', but session role is '${session.role}'`
            };
          }
          taskCandidate = targetTask;
        } else {
          const specifiedTask = runnableTasks.find((t) => t.taskId === input.taskId);
          if (!specifiedTask) {
            return {
              sessionId: session.sessionId,
              role: session.role,
              outcome: "task_not_found",
              dispatchKind: "task",
              taskId: input.taskId,
              reason: `task '${input.taskId}' is not runnable for session '${session.sessionId}'`
            };
          }
          taskCandidate = specifiedTask;

          // Check dependencies are satisfied (for normal dispatch - not force dispatch)
          const depCheck = areTaskDependenciesSatisfied(specifiedTask, allTasks);
          if (!depCheck.satisfied) {
            await appendEvent(paths, {
              projectId: project.projectId,
              eventType: "ORCHESTRATOR_DISPATCH_SKIPPED",
              source: "manager",
              sessionId: session.sessionId,
              taskId: input.taskId,
              payload: {
                mode: input.mode,
                dispatchKind: "task",
                dispatchSkipReason: "dependency_gate_closed",
                unsatisfiedDependencyIds: depCheck.unsatisfiedDeps,
                blockingTaskIds: depCheck.blockingTaskIds
              }
            });
            return {
              sessionId: session.sessionId,
              role: session.role,
              outcome: "task_not_found",
              dispatchKind: "task",
              taskId: input.taskId,
              reason:
                "task '" +
                input.taskId +
                "' dependency gate is closed; unsatisfied_dependencies=[" +
                depCheck.unsatisfiedDeps.join(", ") +
                "], blocking_tasks=[" +
                depCheck.blockingTaskIds.join(", ") +
                "]"
            };
          }
        }
      }

      if (taskCandidate) {
        selectedMessages = [buildTaskAssignmentMessage(project, session, taskCandidate)];
        selectedTaskId = taskCandidate.taskId;
        dispatchKind = "task";
      }
    }
  }

  logger.info(
    `[dispatchSessionOnce] sessionId=${session.sessionId}, role=${session.role}, session.status=${session.status}, dispatchKind=${dispatchKind}, selectedTaskId=${selectedTaskId}, messageCount=${selectedMessages.length}, onlyIdle=${input.onlyIdle}`
  );
  if (selectedMessages.length === 0) {
    return {
      sessionId: session.sessionId,
      role: session.role,
      outcome: input.messageId ? "message_not_found" : input.taskId ? "task_not_found" : "no_message",
      dispatchKind,
      messageId: input.messageId,
      taskId: input.taskId
    };
  }

  if (input.onlyIdle && session.status !== "idle") {
    return {
      sessionId: session.sessionId,
      role: session.role,
      outcome: "session_busy",
      dispatchKind,
      reason: `session status is ${session.status}`
    };
  }

  const firstMessage = selectedMessages[0];
  const selectedMessageIds = selectedMessages.map((m) => m.envelope.message_id);
  logger.info(
    `[dispatchSessionOnce] sessionId=${session.sessionId}, selectedMessageIds=${JSON.stringify(selectedMessageIds)}, lastInboxMessageId=${session.lastInboxMessageId ?? "null"}, force=${input.force}`
  );

  if (!input.force && dispatchKind === "message" && session.lastInboxMessageId === firstMessage.envelope.message_id) {
    return {
      sessionId: session.sessionId,
      role: session.role,
      outcome: "already_dispatched",
      dispatchKind,
      messageId: firstMessage.envelope.message_id,
      requestId: firstMessage.envelope.correlation.request_id
    };
  }

  const taskId = selectedTaskId;
  if (dispatchKind === "task" && taskId && !input.force) {
    const events = await listEvents(paths);
    if (hasOpenTaskDispatch(events, taskId, session.sessionId)) {
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "ORCHESTRATOR_DISPATCH_SKIPPED",
        source: "manager",
        sessionId: session.sessionId,
        taskId,
        payload: {
          mode: input.mode,
          dispatchKind,
          messageIds: selectedMessageIds,
          requestId: firstMessage.envelope.correlation.request_id,
          dispatchSkipReason: "duplicate_open_dispatch"
        }
      });
      return {
        sessionId: session.sessionId,
        role: session.role,
        outcome: "already_dispatched",
        dispatchKind,
        messageId: firstMessage.envelope.message_id,
        requestId: firstMessage.envelope.correlation.request_id,
        taskId,
        reason: "duplicate_open_dispatch"
      };
    }
  }
  const startedAt = new Date().toISOString();
  const dispatchId = randomUUID();
  logger.info(
    `[dispatchSessionOnce] sessionId=${session.sessionId}, starting dispatch: dispatchId=${dispatchId}, dispatchKind=${dispatchKind}, messageIds=${JSON.stringify(selectedMessageIds)}`
  );

  logger.info(`[dispatchSessionOnce] sessionId=${session.sessionId}, phase=ensureProjectAgentScripts`);
  await ensureProjectAgentScripts(project);
  logger.info(`[dispatchSessionOnce] sessionId=${session.sessionId}, phase=ensureAgentWorkspaces`);
  await ensureAgentWorkspaces(project, rolePromptMap, [session.role]);
  logger.info(`[dispatchSessionOnce] sessionId=${session.sessionId}, phase=ensureRolePromptFile`);
  await ensureRolePromptFile(project, session.role);

  logger.info(`[dispatchSessionOnce] sessionId=${session.sessionId}, phase=appendEvent ORCHESTRATOR_DISPATCH_STARTED`);

  await appendEvent(paths, {
    projectId: project.projectId,
    eventType: "ORCHESTRATOR_DISPATCH_STARTED",
    source: "manager",
    sessionId: session.sessionId,
    taskId,
    payload: {
      dispatchId,
      mode: input.mode,
      dispatchKind,
      messageIds: selectedMessageIds,
      requestId: firstMessage.envelope.correlation.request_id
    }
  });

  let latestRunId: string | undefined;
  try {
    const routingSnapshot = buildProjectRoutingSnapshot(project, session.role, registeredAgentIds);
    const runtimeSettings = await getRuntimeSettings(dataRoot);
    const modelConfig = project.agentModelConfigs?.[session.role];
    const cliTool = modelConfig?.tool ?? "codex";
    if (cliTool !== "codex" && cliTool !== "trae" && cliTool !== "minimax") {
      throw new Error(`SESSION_PROVIDER_NOT_SUPPORTED: role '${session.role}' configured tool '${cliTool}'`);
    }
    const modelCommand =
      cliTool === "minimax"
        ? undefined
        : cliTool === "trae"
          ? runtimeSettings.traeCliCommand
          : runtimeSettings.codexCliCommand;
    const modelParams: Record<string, string> = {};
    if (modelConfig?.model) {
      modelParams.model = modelConfig.model;
    }
    if (modelConfig?.effort) {
      if (cliTool === "codex") {
        modelParams.config = `model_reasoning_effort="${modelConfig.effort}"`;
      } else if (cliTool === "trae") {
        modelParams["reasoning-effort"] = modelConfig.effort;
      }
    }

    let activeTaskTitle = "";
    let activeParentTaskId = "";
    let activeRootTaskId = "";
    if (taskId) {
      const allTasksForContext = await listTasks(paths, project.projectId);
      const activeTask = allTasksForContext.find((item) => item.taskId === taskId);
      if (activeTask) {
        activeTaskTitle = activeTask.title ?? "";
        activeParentTaskId = activeTask.parentTaskId ?? "";
        activeRootTaskId = activeTask.rootTaskId ?? "";
      }
    }

    const prompt = buildPromptFromMessages(project, session, selectedMessages, routingSnapshot, taskId);

    const promptFileName = `${startedAt.replace(/[:.]/g, "-")}_${session.sessionId}_${dispatchId}.md`;
    const promptFilePath = path.join(paths.promptsDir, promptFileName);
    await fs.writeFile(promptFilePath, prompt, "utf-8");
    logger.info(`[dispatchSessionOnce] saved prompt to: ${promptFilePath}`);

    const runBaseInput = {
      session_id: session.sessionId,
      agent_role: session.role,
      task_id: taskId,
      active_task_title: activeTaskTitle,
      active_parent_task_id: activeParentTaskId,
      active_root_task_id: activeRootTaskId,
      active_request_id: firstMessage.envelope.correlation.request_id,
      parent_request_id:
        firstMessage.envelope.correlation.parent_request_id ?? firstMessage.envelope.correlation.request_id,
      dispatch_id: dispatchId,
      cli_tool: cliTool,
      model_command: modelCommand,
      model_params: Object.keys(modelParams).length > 0 ? modelParams : undefined,
      prompt
    };
    const resumeCandidate =
      session.providerSessionId?.trim() || (!isPendingSessionId(session.sessionId) ? session.sessionId : "");
    const canAttemptResume = cliTool === "codex" && Boolean(resumeCandidate);

    let run: Awaited<ReturnType<typeof runModelForProject>> | null = null;
    let runError: unknown = null;
    let resumedFailedAndReset = false;

    if (cliTool === "minimax") {
      logger.info(`[dispatchSessionOnce] sessionId=${session.sessionId}, phase=startMiniMaxForProject ASYNC`);

      const launchContext: MiniMaxLauncherContext = {
        dataRoot,
        project,
        paths,
        session,
        taskId,
        dispatchId,
        dispatchKind,
        selectedMessageIds,
        firstMessage,
        startedAt,
        input
      };

      const pendingMessages = selectedMessageIds.map((messageId) => ({
        messageId,
        dispatchedAt: new Date().toISOString()
      }));
      await addPendingMessagesForRole(paths, project.projectId, session.role, pendingMessages);

      const startResult = startMiniMaxForProject(
        project,
        paths,
        {
          sessionId: session.sessionId,
          prompt,
          dispatchId,
          taskId,
          activeTaskTitle,
          activeParentTaskId,
          activeRootTaskId,
          activeRequestId: firstMessage.envelope.correlation.request_id,
          agentRole: session.role,
          cliTool: "minimax",
          model: modelConfig?.model,
          modelParams
        },
        runtimeSettings,
        {
          wakeUpCallback: async (wakeSessionId, wakeRunId) => {
            logger.info(
              `[dispatchSessionOnce] WakeUp callback triggered for sessionId=${wakeSessionId}, runId=${wakeRunId}`
            );
            await handleMinMaxWakeUp(wakeSessionId, wakeRunId, launchContext);
          },
          completionCallback: async (result, completionSessionId, completionRunId) => {
            try {
              await handleMiniMaxCompletion(result, completionSessionId, completionRunId, launchContext);
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              logger.error(`[dispatchSessionOnce] MiniMax completion callback error: ${reason}`);
              await markRunnerFatalError({
                dataRoot,
                project,
                paths,
                sessionId: completionSessionId,
                taskId,
                messageId: dispatchKind === "message" ? firstMessage.envelope.message_id : undefined,
                runId: completionRunId,
                dispatchId,
                provider: "minimax",
                error: `minimax completion callback failed: ${reason}`
              });
              await appendEvent(paths, {
                projectId: project.projectId,
                eventType: "ORCHESTRATOR_DISPATCH_FAILED",
                source: "manager",
                sessionId: completionSessionId,
                taskId,
                payload: {
                  dispatchId,
                  mode: input.mode,
                  dispatchKind,
                  messageIds: selectedMessageIds,
                  requestId: firstMessage.envelope.correlation.request_id,
                  runId: completionRunId,
                  error: `minimax completion callback failed: ${reason}`
                }
              });
            }
          }
        }
      );
      launchContext.runId = startResult.runId;

      logger.info(
        `[dispatchSessionOnce] sessionId=${session.sessionId}, MiniMax started async, runId=${startResult.runId}`
      );

      return {
        sessionId: session.sessionId,
        role: session.role,
        outcome: "dispatched",
        dispatchKind,
        messageId: firstMessage.envelope.message_id,
        requestId: firstMessage.envelope.correlation.request_id,
        runId: startResult.runId,
        exitCode: null,
        timedOut: false,
        taskId
      };
    }

    await markRunnerStarted({
      dataRoot,
      project,
      paths,
      sessionId: session.sessionId,
      taskId,
      messageId: dispatchKind === "message" ? firstMessage.envelope.message_id : undefined,
      dispatchId,
      provider: cliTool
    });

    logger.info(
      `[dispatchSessionOnce] sessionId=${session.sessionId}, phase=runModelForProject START, cliTool=${cliTool}`
    );
    try {
      run = await runModelForProject(
        project,
        paths,
        {
          ...runBaseInput,
          resume_session_id: resumeCandidate
        },
        runtimeSettings
      );
      logger.info(
        `[dispatchSessionOnce] sessionId=${session.sessionId}, phase=runModelForProject END, runId=${run?.runId}, exitCode=${run?.exitCode}`
      );
    } catch (error) {
      logger.info(
        `[dispatchSessionOnce] sessionId=${session.sessionId}, phase=runModelForProject ERROR: ${error instanceof Error ? error.message : String(error)}`
      );
      runError = error;
    }

    const shouldFallbackToExec = canAttemptResume && runError !== null;

    if (shouldFallbackToExec) {
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "CODEX_RESUME_FAILED",
        source: "manager",
        sessionId: session.sessionId,
        taskId,
        payload: {
          requestId: firstMessage.envelope.correlation.request_id,
          resumeSessionId: resumeCandidate || null,
          runId: run?.runId ?? null,
          exitCode: run?.exitCode ?? null,
          timedOut: run?.timedOut ?? null,
          error: runError instanceof Error ? runError.message : runError ? String(runError) : null
        }
      });

      resumedFailedAndReset = true;
      await touchSession(paths, project.projectId, session.sessionId, { providerSessionId: null });
      run = null;
      runError = null;

      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "CODEX_RESUME_FALLBACK_EXEC",
        source: "manager",
        sessionId: session.sessionId,
        taskId,
        payload: {
          requestId: firstMessage.envelope.correlation.request_id,
          previousResumeSessionId: resumeCandidate || null
        }
      });

      try {
        run = await runModelForProject(project, paths, runBaseInput, runtimeSettings);
        if (run) {
          latestRunId = run.runId;
        }
      } catch (fallbackError) {
        runError = fallbackError;
      }
    }

    if (run) {
      latestRunId = run.runId;
    }
    if (runError || !run) {
      throw runError instanceof Error ? runError : new Error(runError ? String(runError) : "model run failed");
    }

    logger.info(
      `[dispatchSessionOnce] sessionId=${session.sessionId}, run completed: timedOut=${run.timedOut}, exitCode=${run.exitCode}`
    );
    const fallbackSessionIdBase = resumedFailedAndReset ? undefined : resumeCandidate || undefined;
    const nextProviderSessionId = run.sessionId ?? fallbackSessionIdBase;
    const targetSessionIdForUpdate = session.sessionId;

    if (dispatchKind === "message") {
      const pendingMessages = selectedMessages.map((msg) => ({
        messageId: msg.envelope.message_id,
        dispatchedAt: new Date().toISOString()
      }));
      await addPendingMessagesForRole(paths, project.projectId, session.role, pendingMessages);
    }

    await confirmPendingMessagesForRole(paths, project.projectId, session.role);

    if (dispatchKind === "task" && taskId) {
      const allTasks = await listTasks(paths, project.projectId);
      const currentTask = allTasks.find((t) => t.taskId === taskId);
      if (currentTask) {
        const ACTIVE_STATES = new Set(["DISPATCHED", "IN_PROGRESS"]);
        const TERMINAL_STATES = new Set(["DONE", "CANCELED"]);
        if (!ACTIVE_STATES.has(currentTask.state) && !TERMINAL_STATES.has(currentTask.state)) {
          await patchTask(paths, project.projectId, taskId, {
            state: "DISPATCHED",
            grantedAt: new Date().toISOString()
          });
        }
      }
    }

    let dispatchFailedReason: string | null = null;
    if (run.timedOut) {
      const timeoutResult = await markRunnerTimeout({
        dataRoot,
        project,
        paths,
        sessionId: targetSessionIdForUpdate,
        taskId,
        messageId: dispatchKind === "message" ? firstMessage.envelope.message_id : undefined,
        runId: run.runId,
        dispatchId,
        providerSessionId: nextProviderSessionId ?? null,
        provider: cliTool
      });
      if (timeoutResult.escalated) {
        dispatchFailedReason = "runner timeout escalated";
      }
    } else if (run.exitCode === 0) {
      await markRunnerSuccess({
        dataRoot,
        project,
        paths,
        sessionId: targetSessionIdForUpdate,
        taskId,
        messageId: dispatchKind === "message" ? firstMessage.envelope.message_id : undefined,
        runId: run.runId,
        dispatchId,
        providerSessionId: nextProviderSessionId ?? null,
        provider: cliTool
      });
    } else {
      const runErrorMessage =
        typeof (run as { error?: unknown }).error === "string" ? (run as { error?: string }).error : undefined;
      dispatchFailedReason = runErrorMessage ?? `runner exited with code ${run.exitCode}`;
      await markRunnerFatalError({
        dataRoot,
        project,
        paths,
        sessionId: targetSessionIdForUpdate,
        taskId,
        messageId: dispatchKind === "message" ? firstMessage.envelope.message_id : undefined,
        runId: run.runId,
        dispatchId,
        providerSessionId: nextProviderSessionId ?? null,
        provider: cliTool,
        error: dispatchFailedReason
      });
    }

    await appendEvent(paths, {
      projectId: project.projectId,
      eventType: dispatchFailedReason ? "ORCHESTRATOR_DISPATCH_FAILED" : "ORCHESTRATOR_DISPATCH_FINISHED",
      source: "manager",
      sessionId: targetSessionIdForUpdate,
      taskId,
      payload: {
        dispatchId,
        mode: input.mode,
        dispatchKind,
        messageIds: selectedMessageIds,
        requestId: firstMessage.envelope.correlation.request_id,
        runId: run.runId,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        startedAt,
        finishedAt: run.finishedAt,
        ...(dispatchFailedReason ? { error: dispatchFailedReason } : {})
      }
    });

    if (dispatchFailedReason) {
      return {
        sessionId: targetSessionIdForUpdate,
        role: session.role,
        outcome: "dispatch_failed",
        dispatchKind,
        reason: dispatchFailedReason,
        messageId: firstMessage.envelope.message_id,
        requestId: firstMessage.envelope.correlation.request_id,
        runId: run.runId,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        taskId
      };
    }
    return {
      sessionId: targetSessionIdForUpdate,
      role: session.role,
      outcome: "dispatched",
      dispatchKind,
      messageId: firstMessage.envelope.message_id,
      requestId: firstMessage.envelope.correlation.request_id,
      runId: run.runId,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      taskId
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown error";
    console.error(`[dispatchSessionOnce] sessionId=${session.sessionId}, dispatch failed: ${reason}`);
    if (reason.includes("role.md")) {
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "AGENT_ROLE_TEMPLATE_MISSING",
        source: "manager",
        sessionId: session.sessionId,
        taskId,
        payload: {
          role: session.role,
          reason
        }
      });
    }
    await markRunnerFatalError({
      dataRoot,
      project,
      paths,
      sessionId: session.sessionId,
      taskId,
      messageId: dispatchKind === "message" ? firstMessage.envelope.message_id : undefined,
      runId: latestRunId,
      dispatchId,
      provider: session.provider ?? "codex",
      error: reason
    });
    await appendEvent(paths, {
      projectId: project.projectId,
      eventType: "ORCHESTRATOR_DISPATCH_FAILED",
      source: "manager",
      sessionId: session.sessionId,
      taskId,
      payload: {
        dispatchId,
        mode: input.mode,
        dispatchKind,
        messageIds: selectedMessageIds,
        requestId: firstMessage.envelope.correlation.request_id,
        error: reason
      }
    });
    return {
      sessionId: session.sessionId,
      role: session.role,
      outcome: "dispatch_failed",
      dispatchKind,
      reason,
      messageId: firstMessage.envelope.message_id,
      requestId: firstMessage.envelope.correlation.request_id,
      taskId
    };
  }
}

export class OrchestratorService {
  private readonly options: OrchestratorOptions;
  private readonly loopCore: OrchestratorLoopCore;
  private readonly inFlightDispatchSessionKeys = new Set<string>();
  private readonly projectHoldState = new Map<string, boolean>();
  private readonly limitEventSent = new Set<string>();
  private readonly lastObservabilityEventAt = new Map<string, number>();

  constructor(options: OrchestratorOptions) {
    this.options = options;
    this.loopCore = new OrchestratorLoopCore({
      enabled: this.options.enabled,
      intervalMs: this.options.intervalMs,
      onTick: async () => {
        await this.tickLoop();
      },
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[orchestrator] tickLoop failed: ${message}`);
      }
    });
  }

  async getStatus() {
    const loop = this.loopCore.getSnapshot();
    const projects = await listProjects(this.options.dataRoot);
    const perProject: Array<{
      projectId: string;
      autoDispatchEnabled: boolean;
      autoDispatchRemaining: number;
      holdEnabled: boolean;
      reminderMode: "backoff" | "fixed_interval";
    }> = [];
    for (const item of projects) {
      const project = await getProject(this.options.dataRoot, item.projectId);
      perProject.push({
        projectId: project.projectId,
        autoDispatchEnabled: Boolean(project.autoDispatchEnabled ?? true),
        autoDispatchRemaining: Number(project.autoDispatchRemaining ?? 5),
        holdEnabled: Boolean(project.holdEnabled ?? false),
        reminderMode: project.reminderMode ?? "backoff"
      });
    }
    return {
      enabled: loop.enabled,
      running: loop.running,
      started: loop.started,
      intervalMs: loop.intervalMs,
      maxConcurrentDispatches: this.options.maxConcurrentDispatches,
      inFlightDispatchSessions: this.inFlightDispatchSessionKeys.size,
      lastTickAt: loop.lastTickAt,
      projects: perProject
    };
  }

  private buildSessionDispatchKey(projectId: string, sessionId: string): string {
    return buildOrchestratorContextSessionKey(projectId, sessionId);
  }

  private resolveTerminationPid(session: SessionRecord, sessionEvents: EventRecord[]): number | null {
    if (typeof session.agentPid === "number" && Number.isFinite(session.agentPid) && session.agentPid > 0) {
      return Math.floor(session.agentPid);
    }
    const openRun = findLatestOpenRun(sessionEvents);
    if (!openRun) {
      return null;
    }
    const payload = (openRun.event.payload ?? {}) as Record<string, unknown>;
    return readPidFromEventPayload(payload);
  }

  private async terminateProcessByPid(pid: number): Promise<SessionProcessTerminationResult> {
    if (process.platform === "win32") {
      return new Promise((resolve) => {
        const proc = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "pipe"
        });
        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (data) => {
          stdout += data.toString();
        });
        proc.stderr?.on("data", (data) => {
          stderr += data.toString();
        });
        proc.on("error", (err) => {
          resolve({
            attempted: true,
            pid,
            result: "failed",
            message: err.message
          });
        });
        proc.on("close", (code) => {
          if (code === 0) {
            resolve({
              attempted: true,
              pid,
              result: "killed",
              message: "process tree terminated"
            });
            return;
          }
          const out = `${stdout}\n${stderr}`.toLowerCase();
          if (out.includes("not found") || out.includes("no running instance")) {
            resolve({
              attempted: true,
              pid,
              result: "not_found",
              message: "process not found"
            });
            return;
          }
          if (out.includes("access is denied")) {
            resolve({
              attempted: true,
              pid,
              result: "access_denied",
              message: "access denied when terminating process"
            });
            return;
          }
          resolve({
            attempted: true,
            pid,
            result: "failed",
            message: (stderr || stdout || "taskkill failed").trim() || "taskkill failed"
          });
        });
      });
    }

    return new Promise((resolve) => {
      try {
        process.kill(pid, "SIGKILL");
        resolve({
          attempted: true,
          pid,
          result: "killed",
          message: "process terminated"
        });
      } catch (error) {
        const known = error as NodeJS.ErrnoException;
        if (known.code === "ESRCH") {
          resolve({
            attempted: true,
            pid,
            result: "not_found",
            message: "process not found"
          });
          return;
        }
        if (known.code === "EPERM") {
          resolve({
            attempted: true,
            pid,
            result: "access_denied",
            message: "access denied when terminating process"
          });
          return;
        }
        resolve({
          attempted: true,
          pid,
          result: "failed",
          message: known.message || "failed to terminate process"
        });
      }
    });
  }

  private async terminateSessionProcessInternal(
    project: ProjectRecord,
    paths: ProjectPaths,
    session: SessionRecord,
    reason: string
  ): Promise<SessionProcessTerminationResult> {
    if (session.lastRunId) {
      unregisterMiniMaxCompletionCallback(session.lastRunId);
      unregisterMiniMaxWakeUpCallback(session.lastRunId);
    }
    if (isMiniMaxRunnerActive(session.sessionId)) {
      const cancelled = cancelMiniMaxRunner(session.sessionId);
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "SESSION_PROCESS_TERMINATION_ATTEMPTED",
        source: "manager",
        sessionId: session.sessionId,
        taskId: session.currentTaskId,
        payload: {
          reason,
          type: "minimax_cancel"
        }
      });
      if (cancelled) {
        await appendEvent(paths, {
          projectId: project.projectId,
          eventType: "SESSION_PROCESS_TERMINATION_FINISHED",
          source: "manager",
          sessionId: session.sessionId,
          taskId: session.currentTaskId,
          payload: {
            reason,
            type: "minimax_cancel",
            result: "cancelled",
            message: "MiniMax runner cancelled"
          }
        });
        return {
          attempted: true,
          pid: null,
          result: "killed",
          message: "MiniMax runner cancelled"
        };
      }
    }

    const events = await listEvents(paths);
    const sessionEvents = events.filter((item) => item.sessionId === session.sessionId);
    const pid = this.resolveTerminationPid(session, sessionEvents);
    if (!pid) {
      return {
        attempted: false,
        pid: null,
        result: "skipped_no_pid",
        message: "no process pid available for this session"
      };
    }

    await appendEvent(paths, {
      projectId: project.projectId,
      eventType: "SESSION_PROCESS_TERMINATION_ATTEMPTED",
      source: "manager",
      sessionId: session.sessionId,
      taskId: session.currentTaskId,
      payload: {
        reason,
        pid
      }
    });

    const outcome = await this.terminateProcessByPid(pid);
    if (outcome.result === "killed" || outcome.result === "not_found") {
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "SESSION_PROCESS_TERMINATION_FINISHED",
        source: "manager",
        sessionId: session.sessionId,
        taskId: session.currentTaskId,
        payload: {
          reason,
          pid,
          result: outcome.result,
          message: outcome.message
        }
      });
    } else {
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "SESSION_PROCESS_TERMINATION_FAILED",
        source: "manager",
        sessionId: session.sessionId,
        taskId: session.currentTaskId,
        payload: {
          reason,
          pid,
          result: outcome.result,
          message: outcome.message
        }
      });
    }
    return outcome;
  }

  async terminateSessionProcess(
    projectId: string,
    sessionId: string,
    reason: string
  ): Promise<SessionProcessTerminationResult> {
    const project = await getProject(this.options.dataRoot, projectId);
    const paths = await ensureProjectRuntime(this.options.dataRoot, project.projectId);
    const session = await getSession(paths, project.projectId, sessionId);
    if (!session) {
      return {
        attempted: false,
        pid: null,
        result: "not_found",
        message: `session '${sessionId}' not found`
      };
    }
    return this.terminateSessionProcessInternal(project, paths, session, reason);
  }

  private async dispatchSessionWithSingleFlight(
    project: ProjectRecord,
    paths: ProjectPaths,
    session: SessionRecord,
    input: DispatchProjectInput,
    rolePromptMap: Map<string, string>,
    registeredAgentIds: string[]
  ): Promise<SessionDispatchResult> {
    const key = this.buildSessionDispatchKey(project.projectId, session.sessionId);
    logger.info(`[dispatchSessionWithSingleFlight] key=${key}, inFlight=${this.inFlightDispatchSessionKeys.has(key)}`);
    if (this.inFlightDispatchSessionKeys.has(key)) {
      logger.info(`[dispatchSessionWithSingleFlight] skip: session already dispatching, key=${key}`);
      return {
        sessionId: session.sessionId,
        role: session.role,
        outcome: "session_busy",
        dispatchKind: null,
        reason: "session already dispatching"
      };
    }
    this.inFlightDispatchSessionKeys.add(key);
    logger.info(
      `[dispatchSessionWithSingleFlight] added to inFlight: key=${key}, current inFlight=[${Array.from(this.inFlightDispatchSessionKeys).join(", ")}]`
    );
    try {
      return await dispatchSessionOnce(
        this.options.dataRoot,
        project,
        paths,
        session,
        input,
        rolePromptMap,
        registeredAgentIds
      );
    } finally {
      this.inFlightDispatchSessionKeys.delete(key);
      logger.info(
        `[dispatchSessionWithSingleFlight] removed from inFlight: key=${key}, remaining inFlight=[${Array.from(this.inFlightDispatchSessionKeys).join(", ")}]`
      );
    }
  }

  start(): void {
    this.loopCore.start();
  }

  stop(): void {
    this.loopCore.stop();
    this.projectHoldState.clear();
  }

  async repairSessionStatus(
    projectId: string,
    sessionId: string,
    targetStatus: "idle" | "blocked"
  ): Promise<SessionRecord> {
    const project = await getProject(this.options.dataRoot, projectId);
    const paths = await ensureProjectRuntime(this.options.dataRoot, project.projectId);
    const session = await getSession(paths, project.projectId, sessionId);
    if (!session) {
      throw new Error(`session '${sessionId}' not found`);
    }
    const updated = await touchSession(paths, project.projectId, sessionId, {
      status: targetStatus,
      agentPid: null
    });
    await appendEvent(paths, {
      projectId: project.projectId,
      eventType: "SESSION_STATUS_REPAIRED",
      source: "dashboard",
      sessionId,
      taskId: updated.currentTaskId,
      payload: {
        previousStatus: session.status,
        targetStatus
      }
    });
    return updated;
  }

  async resetRoleReminderOnManualAction(
    projectId: string,
    role: string,
    reason: "session_created" | "session_dismissed" | "session_repaired" | "force_dispatch_succeeded"
  ): Promise<void> {
    const normalizedRole = role.trim();
    if (!normalizedRole) {
      return;
    }
    const project = await getProject(this.options.dataRoot, projectId);
    const paths = await ensureProjectRuntime(this.options.dataRoot, project.projectId);
    const existing = await getRoleReminderState(paths, project.projectId, normalizedRole);
    const previousReminderCount = existing?.reminderCount ?? 0;
    const reminderMode = project.reminderMode ?? "backoff";
    const delayedReminderAt = calculateNextReminderTimeByMode(reminderMode, 0, Date.now(), {
      initialWaitMs: this.options.idleTimeoutMs,
      backoffMultiplier: this.options.reminderBackoffMultiplier ?? 2,
      maxWaitMs: this.options.reminderMaxIntervalMs ?? 1800000
    });
    await updateRoleReminderState(paths, project.projectId, normalizedRole, {
      reminderCount: 0,
      idleSince: undefined,
      nextReminderAt: delayedReminderAt,
      lastRoleState: "INACTIVE"
    });
    await appendEvent(paths, {
      projectId: project.projectId,
      eventType: "ORCHESTRATOR_ROLE_REMINDER_RESET",
      source: "manager",
      payload: {
        role: normalizedRole,
        reason,
        previousReminderCount,
        nextReminderAt: delayedReminderAt
      }
    });
  }

  async dispatchProject(
    projectId: string,
    input: Omit<DispatchProjectInput, "mode"> & { mode?: DispatchMode }
  ): Promise<ProjectDispatchResult> {
    const mode = input.mode ?? "manual";
    const project = await getProject(this.options.dataRoot, projectId);
    const paths = await ensureProjectRuntime(this.options.dataRoot, project.projectId);
    const selected = await (input.sessionId
      ? (() => {
          const target = getSession(paths, project.projectId, input.sessionId);
          return target.then((item) => (item ? [item] : []));
        })()
      : listSessions(paths, project.projectId));
    const agentList = await listAgents(this.options.dataRoot);
    const rolePromptMap = new Map(agentList.map((item) => [item.agentId, item.prompt]));
    const registeredAgentIds = agentList.map((item) => item.agentId);
    if (input.sessionId && selected.length === 0) {
      return {
        projectId: project.projectId,
        mode,
        results: [
          {
            sessionId: input.sessionId,
            role: "unknown",
            outcome: "session_not_found",
            dispatchKind: null
          }
        ]
      };
    }

    let forceBootstrappedSessionId: string | null = null;
    if (input.force && input.taskId) {
      const allTasks = await listTasks(paths, project.projectId);
      const targetTask = allTasks.find((item) => item.taskId === input.taskId);
      if (!targetTask) {
        return {
          projectId: project.projectId,
          mode,
          results: [
            {
              sessionId: input.sessionId ?? "unknown",
              role: "unknown",
              outcome: "task_not_found",
              dispatchKind: "task",
              taskId: input.taskId,
              reason: `task '${input.taskId}' does not exist (hint: refresh task-tree and retry with current task_id)`
            }
          ]
        };
      }
      if (!isForceDispatchableState(targetTask.state)) {
        return {
          projectId: project.projectId,
          mode,
          results: [
            {
              sessionId: targetTask.ownerSession ?? input.sessionId ?? "unknown",
              role: targetTask.ownerRole,
              outcome: "task_not_force_dispatchable",
              dispatchKind: "task",
              taskId: input.taskId,
              reason: `task '${input.taskId}' state=${targetTask.state} is not force-dispatchable`
            }
          ]
        };
      }

      if (!input.sessionId) {
        const activeOwnerSession = await resolveActiveSessionForRole({
          dataRoot: this.options.dataRoot,
          project,
          paths,
          role: targetTask.ownerRole,
          reason: "force_dispatch_owner_resolution"
        });
        if (activeOwnerSession && activeOwnerSession.status !== "dismissed") {
          input.sessionId = activeOwnerSession.sessionId;
        } else {
          const newSessionId = buildPendingSessionId(targetTask.ownerRole);
          const ownerAgentTool = project.agentModelConfigs?.[targetTask.ownerRole]?.tool ?? "codex";
          const created = await addSession(paths, project.projectId, {
            sessionId: newSessionId,
            role: targetTask.ownerRole,
            status: "idle",
            providerSessionId: undefined,
            provider: ownerAgentTool as "codex" | "trae" | "minimax"
          });
          await patchTask(paths, project.projectId, targetTask.taskId, {
            ownerSession: created.session.sessionId
          });
          await setRoleSessionMapping(
            this.options.dataRoot,
            project.projectId,
            targetTask.ownerRole,
            created.session.sessionId
          );
          await appendEvent(paths, {
            projectId: project.projectId,
            eventType: "SESSION_AUTO_BOOTSTRAPPED_FOR_FORCE_DISPATCH",
            source: "manager",
            sessionId: created.session.sessionId,
            taskId: targetTask.taskId,
            payload: {
              taskId: targetTask.taskId,
              ownerRole: targetTask.ownerRole,
              newSessionId: created.session.sessionId,
              reason: "no_active_owner_session"
            }
          });
          input.sessionId = created.session.sessionId;
          forceBootstrappedSessionId = created.session.sessionId;
        }
      }
    }

    const effectiveSelected = input.sessionId
      ? (() => {
          const target = selected.find((item) => item.sessionId === input.sessionId);
          return target ? [target] : [];
        })()
      : selected;
    if (input.sessionId && effectiveSelected.length === 0) {
      const target = await getSession(paths, project.projectId, input.sessionId);
      if (target) {
        effectiveSelected.push(target);
      }
    }

    if (input.sessionId && effectiveSelected.length === 0) {
      return {
        projectId: project.projectId,
        mode,
        results: [
          {
            sessionId: input.sessionId,
            role: "unknown",
            outcome: "session_not_found",
            dispatchKind: null
          }
        ]
      };
    }

    const rolesToResolve = Array.from(new Set(effectiveSelected.map((item) => item.role)));
    const activeSessionByRole = new Map<string, SessionRecord>();
    for (const role of rolesToResolve) {
      const active = await resolveActiveSessionForRole({
        dataRoot: this.options.dataRoot,
        project,
        paths,
        role,
        reason: "dispatch_project"
      });
      if (active) {
        activeSessionByRole.set(role, active);
      }
    }

    let orderedSessions =
      mode === "loop" && !input.sessionId
        ? [...activeSessionByRole.values()].sort((a, b) => {
            const aKey = Date.parse(a.lastDispatchedAt ?? a.lastActiveAt ?? a.createdAt);
            const bKey = Date.parse(b.lastDispatchedAt ?? b.lastActiveAt ?? b.createdAt);
            if (aKey !== bKey) {
              return aKey - bKey;
            }
            return a.sessionId.localeCompare(b.sessionId);
          })
        : [...activeSessionByRole.values()];

    if (input.sessionId) {
      const requestedSession = effectiveSelected[0];
      if (!requestedSession) {
        return {
          projectId: project.projectId,
          mode,
          results: [
            {
              sessionId: input.sessionId,
              role: "unknown",
              outcome: "session_not_found",
              dispatchKind: null
            }
          ]
        };
      }
      const activeForRole = activeSessionByRole.get(requestedSession.role);
      if (!activeForRole || activeForRole.sessionId !== requestedSession.sessionId) {
        return {
          projectId: project.projectId,
          mode,
          results: [
            {
              sessionId: requestedSession.sessionId,
              role: requestedSession.role,
              outcome: "session_busy",
              dispatchKind: null,
              reason: "session is not authoritative active session for role"
            }
          ]
        };
      }
      orderedSessions = [activeForRole];
    }

    logger.info(
      `[dispatchProject] projectId=${projectId}, mode=${mode}, orderedSessions=${orderedSessions.length}, sessions=[${orderedSessions.map((s) => `${s.sessionId}:${s.role}:${s.status}`).join(", ")}]`
    );
    logger.info(`[dispatchProject] inFlightSessionKeys: [${Array.from(this.inFlightDispatchSessionKeys).join(", ")}]`);

    const maxDispatches =
      typeof input.maxDispatches === "number" && Number.isFinite(input.maxDispatches) && input.maxDispatches > 0
        ? Math.floor(input.maxDispatches)
        : Number.POSITIVE_INFINITY;

    const results: SessionDispatchResult[] = [];
    let dispatchedCount = 0;
    const dispatchedRoles = new Set<string>();

    for (let i = 0; i < orderedSessions.length; i++) {
      if (dispatchedCount >= maxDispatches) {
        logger.info(`[dispatchProject] reached maxDispatches=${maxDispatches}, breaking loop`);
        break;
      }
      const session = orderedSessions[i];
      logger.info(
        `[dispatchProject] processing session[${i}]: ${session.sessionId}, role=${session.role}, status=${session.status}`
      );
      const freshSession = await getSession(paths, project.projectId, session.sessionId);
      if (!freshSession) {
        logger.info(`[dispatchProject] skip: session ${session.sessionId} not found`);
        continue;
      }
      orderedSessions[i] = freshSession;

      if (freshSession.status === "dismissed") {
        logger.info(`[dispatchProject] skip: session ${freshSession.sessionId} dismissed`);
        continue;
      }
      if (dispatchedRoles.has(freshSession.role)) {
        logger.info(`[dispatchProject] skip: role=${freshSession.role} already dispatched in this cycle`);
        continue;
      }

      const authoritative = await resolveActiveSessionForRole({
        dataRoot: this.options.dataRoot,
        project,
        paths,
        role: freshSession.role,
        reason: "dispatch_session_iteration"
      });
      if (!authoritative || authoritative.sessionId !== freshSession.sessionId) {
        logger.info(
          `[dispatchProject] skip: session ${freshSession.sessionId} is not authoritative active session for role=${freshSession.role}`
        );
        continue;
      }

      if (authoritative.cooldownUntil && Date.parse(authoritative.cooldownUntil) > Date.now()) {
        results.push({
          sessionId: authoritative.sessionId,
          role: authoritative.role,
          outcome: "session_busy",
          dispatchKind: null,
          reason: `session cooldown active until ${authoritative.cooldownUntil}`
        });
        continue;
      }

      const row = await this.dispatchSessionWithSingleFlight(
        project,
        paths,
        authoritative,
        {
          mode,
          force: input.force,
          onlyIdle: input.onlyIdle,
          messageId: input.messageId,
          taskId: input.taskId
        },
        rolePromptMap,
        registeredAgentIds
      );
      results.push(row);
      logger.info(
        `[dispatchProject] dispatch result: sessionId=${freshSession.sessionId}, outcome=${row.outcome}, dispatchKind=${row.dispatchKind}, reason=${row.reason ?? "none"}`
      );
      if (row.outcome === "dispatched") {
        dispatchedCount += 1;
        dispatchedRoles.add(freshSession.role);
        const updatedSession = await getSession(paths, project.projectId, freshSession.sessionId);
        if (updatedSession) {
          orderedSessions[i] = updatedSession;
        }
        const freshProject = await getProject(this.options.dataRoot, projectId);
        project.roleMessageStatus = freshProject.roleMessageStatus;
      }
      if (forceBootstrappedSessionId) {
        row.sessionBootstrapped = true;
        row.resolvedSessionId = row.sessionId;
        if (row.outcome === "dispatched") {
          row.reason = `session_bootstrapped: ${forceBootstrappedSessionId}`;
        }
      }
    }

    return {
      projectId: project.projectId,
      mode,
      results
    };
  }

  async dispatchMessage(
    projectId: string,
    input: { messageId: string; sessionId?: string; force?: boolean; onlyIdle?: boolean }
  ): Promise<ProjectDispatchResult> {
    const result = await this.dispatchProject(projectId, {
      mode: "manual",
      sessionId: input.sessionId,
      messageId: input.messageId,
      force: input.force,
      onlyIdle: input.onlyIdle
    });
    return result;
  }

  private async markTimedOutSessions(project: ProjectRecord, paths: ProjectPaths): Promise<void> {
    const sessions = await listSessions(paths, project.projectId);
    const events = await listEvents(paths);
    const now = Date.now();
    for (const session of sessions) {
      if (session.status !== "running") {
        continue;
      }
      const lastActive = Date.parse(session.lastActiveAt ?? session.updatedAt ?? session.createdAt);
      if (!Number.isFinite(lastActive)) {
        continue;
      }
      if (now - lastActive < this.options.sessionRunningTimeoutMs) {
        continue;
      }

      const sessionToken = session.sessionId;
      const openRunId = session.lastRunId;
      const openDispatchId = session.lastDispatchId;

      await this.terminateSessionProcessInternal(project, paths, session, "session_heartbeat_timeout");

      const sessionEvents = events.filter((item) => item.sessionId === session.sessionId);
      const openDispatch = findLatestOpenDispatch(sessionEvents);
      const openRun = findLatestOpenRun(sessionEvents);
      const timeoutResult = await markRunnerTimeout({
        dataRoot: this.options.dataRoot,
        project,
        paths,
        sessionId: sessionToken,
        taskId: session.currentTaskId ?? openDispatch?.event.taskId,
        runId: openRun?.runId ?? openRunId,
        dispatchId: openDispatch?.dispatchId ?? openDispatchId,
        provider: session.provider ?? "codex"
      });

      if (openDispatch) {
        const payload = openDispatch.event.payload as Record<string, unknown>;
        await appendEvent(paths, {
          projectId: project.projectId,
          eventType: timeoutResult.escalated ? "ORCHESTRATOR_DISPATCH_FAILED" : "ORCHESTRATOR_DISPATCH_FINISHED",
          source: "manager",
          sessionId: sessionToken,
          taskId: session.currentTaskId ?? openDispatch.event.taskId,
          payload: {
            dispatchId: openDispatch.dispatchId,
            mode: payload.mode ?? "loop",
            dispatchKind: payload.dispatchKind ?? "task",
            messageId: payload.messageId ?? null,
            requestId: payload.requestId ?? null,
            runId: openRun?.runId ?? openRunId ?? null,
            exitCode: null,
            timedOut: true,
            ...(timeoutResult.escalated ? { error: "session heartbeat timeout escalated" } : {})
          }
        });
      }

      if (openRun) {
        const payload = openRun.event.payload as Record<string, unknown>;
        await appendEvent(paths, {
          projectId: project.projectId,
          eventType: "CODEX_RUN_FINISHED",
          source: "manager",
          sessionId: sessionToken,
          taskId: session.currentTaskId ?? openRun.event.taskId,
          payload: {
            runId: openRun.runId,
            exitCode: null,
            timedOut: true,
            status: "timeout",
            provider: payload.provider ?? session.provider ?? null,
            mode: payload.mode ?? "exec",
            providerSessionId: payload.providerSessionId ?? session.providerSessionId ?? session.sessionId ?? null,
            synthetic: true,
            reason: "session_heartbeat_timeout"
          }
        });
      }

      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "SESSION_HEARTBEAT_TIMEOUT",
        source: "manager",
        sessionId: sessionToken,
        taskId: session.currentTaskId,
        payload: {
          previousStatus: "running",
          timeoutMs: this.options.sessionRunningTimeoutMs,
          lastActiveAt: session.lastActiveAt,
          escalated: timeoutResult.escalated
        }
      });
    }
  }

  private async tickLoop(): Promise<void> {
    const projectIndex = await listProjects(this.options.dataRoot);
    logger.info(`[Orchestrator] tickLoop: found ${projectIndex.length} projects`);
    await runOrchestratorAdapterTick({
      listContexts: async () => projectIndex,
      tickContext: async (item) => {
        const project = await getProject(this.options.dataRoot, item.projectId);
        const paths = await ensureProjectRuntime(this.options.dataRoot, project.projectId);

        logger.info(
          `[Orchestrator] tickLoop: processing projectId=${project.projectId}, autoDispatchEnabled=${project.autoDispatchEnabled}, autoDispatchRemaining=${project.autoDispatchRemaining}`
        );

        const holdEnabled = Boolean(project.holdEnabled ?? false);
        const previousHold = this.projectHoldState.get(project.projectId);
        if (previousHold === undefined || previousHold !== holdEnabled) {
          await appendEvent(paths, {
            projectId: project.projectId,
            eventType: holdEnabled ? "ORCHESTRATOR_PROJECT_HOLD_ENABLED" : "ORCHESTRATOR_PROJECT_HOLD_DISABLED",
            source: "manager",
            payload: { holdEnabled }
          });
          this.projectHoldState.set(project.projectId, holdEnabled);
        }

        await this.markTimedOutSessions(project, paths);

        if (holdEnabled) {
          await this.emitDispatchObservabilitySnapshot(project, paths);
          return;
        }

        await this.checkIdleRoles(project, paths);

        await this.checkAndMarkMayBeDone(project, paths);

        await this.emitDispatchObservabilitySnapshot(project, paths);

        const enabled = project.autoDispatchEnabled ?? true;
        const remaining = Number(project.autoDispatchRemaining ?? 5);
        if (!enabled) {
          logger.info(`[Orchestrator] tickLoop: projectId=${project.projectId} autoDispatch disabled, skipping`);
          return;
        }
        if (remaining <= 0) {
          if (!this.limitEventSent.has(project.projectId)) {
            await appendEvent(paths, {
              projectId: project.projectId,
              eventType: "ORCHESTRATOR_AUTO_LIMIT_REACHED",
              source: "manager",
              payload: {
                autoDispatchRemaining: 0,
                reason: "remaining_exhausted"
              }
            });
            this.limitEventSent.add(project.projectId);
          }
          return;
        }
        this.limitEventSent.delete(project.projectId);

        const result = await this.dispatchProject(item.projectId, {
          mode: "loop",
          onlyIdle: true,
          force: false,
          maxDispatches: remaining
        });
        const consumed = result.results.filter(
          (row) => row.outcome === "dispatched" && row.dispatchKind === "task"
        ).length;
        logger.info(
          `[Orchestrator] tickLoop: projectId=${project.projectId}, remaining=${remaining}, results=${result.results.length}, consumed=${consumed}, outcomes=[${result.results.map((r) => `${r.sessionId}:${r.outcome}:${r.dispatchKind}`).join(", ")}]`
        );
        if (consumed > 0) {
          const newRemaining = Math.max(0, remaining - consumed);
          logger.info(`[Orchestrator] tickLoop: updating autoDispatchRemaining from ${remaining} to ${newRemaining}`);
          await updateProjectOrchestratorSettings(this.options.dataRoot, project.projectId, {
            autoDispatchRemaining: newRemaining
          });
        }
      }
    });
  }

  /**
   * Check role-level idleness and manage reminder timing.
   * Reminder reset semantics:
   * - auto reset only on INACTIVE -> IDLE
   * - RUNNING -> IDLE does not reset reminderCount
   */
  private async checkIdleRoles(project: ProjectRecord, paths: ProjectPaths): Promise<void> {
    if (project.autoReminderEnabled === false) {
      return;
    }
    const autoReminderEnabled = this.options.autoReminderEnabled ?? true;
    if (!autoReminderEnabled) {
      return;
    }

    const sessions = await listSessions(paths, project.projectId);
    const allTasks = await listTasks(paths, project.projectId);
    const now = new Date().toISOString();
    const nowMs = Date.now();

    const reminderMode = project.reminderMode ?? "backoff";
    const maxRetries = this.options.reminderMaxCount ?? 5;
    const backoffMultiplier = this.options.reminderBackoffMultiplier ?? 2;
    const maxIntervalMs = this.options.reminderMaxIntervalMs ?? 1800000;
    const roleSet = new Set<string>();
    for (const session of sessions) {
      roleSet.add(session.role);
    }
    for (const task of allTasks) {
      if (task.ownerRole?.trim()) {
        roleSet.add(task.ownerRole.trim());
      }
    }

    for (const role of roleSet) {
      const activeSession = await resolveActiveSessionForRole({
        dataRoot: this.options.dataRoot,
        project,
        paths,
        role,
        reason: "check_idle_roles"
      });
      const roleSessions = activeSession ? [activeSession] : [];
      const currentRoleState = resolveRoleRuntimeState(roleSessions);
      const idleSession = resolveLatestIdleSession(roleSessions);
      const roleOpenTasks = allTasks
        .filter((task) => task.ownerRole === role && isRemindableTaskState(task.state))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const hasOpenTask = roleOpenTasks.length > 0;
      const sessionIdleSince = idleSession
        ? (idleSession.idleSince ?? idleSession.lastDispatchedAt ?? idleSession.updatedAt)
        : undefined;

      let reminderState = await getRoleReminderState(paths, project.projectId, role);
      if (!reminderState) {
        reminderState = await updateRoleReminderState(paths, project.projectId, role, {
          idleSince: sessionIdleSince,
          reminderCount: 0,
          lastRoleState: currentRoleState
        });
        logger.info(
          `[Orchestrator] checkIdleRoles: projectId=${project.projectId}, role=${role}, state=${currentRoleState}, idleSince=${sessionIdleSince ?? "none"}, action=created`
        );
      }

      const previousRoleState = reminderState.lastRoleState ?? "INACTIVE";
      const roleStateTransition = `${previousRoleState}->${currentRoleState}`;

      if (shouldAutoResetReminderOnRoleTransition(previousRoleState, currentRoleState)) {
        reminderState = await updateRoleReminderState(paths, project.projectId, role, {
          reminderCount: 0,
          nextReminderAt: calculateNextReminderTimeByMode(reminderMode, 0, nowMs, {
            initialWaitMs: this.options.idleTimeoutMs,
            backoffMultiplier,
            maxWaitMs: maxIntervalMs
          }),
          idleSince: sessionIdleSince,
          lastRoleState: "IDLE"
        });
      } else if (previousRoleState !== "IDLE" && currentRoleState === "IDLE") {
        reminderState = await updateRoleReminderState(paths, project.projectId, role, {
          idleSince: sessionIdleSince,
          nextReminderAt: calculateNextReminderTimeByMode(reminderMode, reminderState.reminderCount, nowMs, {
            initialWaitMs: this.options.idleTimeoutMs,
            backoffMultiplier,
            maxWaitMs: maxIntervalMs
          }),
          lastRoleState: "IDLE"
        });
      } else if (currentRoleState !== "IDLE") {
        reminderState = await updateRoleReminderState(paths, project.projectId, role, {
          lastRoleState: currentRoleState
        });
      } else {
        reminderState = await updateRoleReminderState(paths, project.projectId, role, {
          lastRoleState: "IDLE"
        });
      }

      if (currentRoleState !== "IDLE" || !idleSession) {
        logger.info(
          `[Orchestrator] checkIdleRoles: projectId=${project.projectId}, role=${role}, transition=${roleStateTransition}, action=skip_non_idle_state`
        );
        continue;
      }

      if (!hasOpenTask) {
        reminderState = await updateRoleReminderState(paths, project.projectId, role, {
          reminderCount: 0,
          nextReminderAt: undefined,
          lastRoleState: "IDLE"
        });
        logger.info(
          `[Orchestrator] checkIdleRoles: projectId=${project.projectId}, role=${role}, sessionId=${idleSession.sessionId}, action=reminder_skipped_no_open_task`
        );
        continue;
      }

      const nextReminderTime = reminderState.nextReminderAt ? Date.parse(reminderState.nextReminderAt) : Number.NaN;
      if (reminderState.reminderCount >= maxRetries) {
        logger.info(
          `[Orchestrator] checkIdleRoles: projectId=${project.projectId}, role=${role}, sessionId=${idleSession.sessionId}, reminderCount=${reminderState.reminderCount}, action=max_retries_reached`
        );
        continue;
      }
      if (!reminderState.idleSince) {
        logger.info(
          `[Orchestrator] checkIdleRoles: projectId=${project.projectId}, role=${role}, transition=${roleStateTransition}, sessionId=${idleSession.sessionId}, action=skip_missing_idle_since`
        );
        continue;
      }
      if (!Number.isFinite(nextReminderTime)) {
        reminderState = await updateRoleReminderState(paths, project.projectId, role, {
          nextReminderAt: calculateNextReminderTimeByMode(reminderMode, reminderState.reminderCount, nowMs, {
            initialWaitMs: this.options.idleTimeoutMs,
            backoffMultiplier,
            maxWaitMs: maxIntervalMs
          }),
          lastRoleState: "IDLE"
        });
        logger.info(
          `[Orchestrator] checkIdleRoles: projectId=${project.projectId}, role=${role}, sessionId=${idleSession.sessionId}, action=scheduled_missing_next_reminder`
        );
        continue;
      }
      if (nowMs < nextReminderTime) {
        const idleDurationMs = nowMs - Date.parse(reminderState.idleSince ?? now);
        const idleDurationMinutes = Math.floor(idleDurationMs / 60000);
        logger.info(
          `[Orchestrator] checkIdleRoles: projectId=${project.projectId}, role=${role}, transition=${roleStateTransition}, sessionId=${idleSession.sessionId}, idleDurationMinutes=${idleDurationMinutes}, reminderCount=${reminderState.reminderCount}, nextReminderAt=${reminderState.nextReminderAt}, action=detected`
        );
        continue;
      }

      const nextReminderAt = calculateNextReminderTimeByMode(reminderMode, reminderState.reminderCount, nowMs, {
        initialWaitMs: this.options.idleTimeoutMs,
        backoffMultiplier,
        maxWaitMs: maxIntervalMs
      });

      reminderState = await updateRoleReminderState(paths, project.projectId, role, {
        reminderCount: reminderState.reminderCount + 1,
        nextReminderAt,
        lastRoleState: "IDLE"
      });

      const reminderRequestId = randomUUID();
      const reminderMessageId = randomUUID();
      const primaryTaskId = roleOpenTasks[0]?.taskId;
      const openTaskTitleItems = roleOpenTasks.map((task) => ({
        task_id: task.taskId,
        title: task.title
      }));
      const openTaskTitlePreview = roleOpenTasks
        .slice(0, 3)
        .map((task) => `${task.taskId}: ${task.title}`)
        .join("; ");
      const reminderMessage: ManagerToAgentMessage = {
        envelope: {
          message_id: reminderMessageId,
          project_id: project.projectId,
          timestamp: new Date().toISOString(),
          sender: {
            type: "system",
            role: "manager",
            session_id: "manager-system"
          },
          via: { type: "manager" },
          intent: "SYSTEM_NOTICE",
          priority: "normal",
          correlation: {
            request_id: reminderRequestId
          },
          accountability: {
            owner_role: role,
            report_to: { role: "manager", session_id: "manager-system" },
            expect: "TASK_REPORT"
          },
          dispatch_policy: "fixed_session"
        },
        body: {
          mode: "CHAT",
          messageType: "MANAGER_MESSAGE",
          content:
            `Reminder: you have ${roleOpenTasks.length} open task(s) without recent progress. ` +
            (openTaskTitlePreview.length > 0 ? `Open tasks: ${openTaskTitlePreview}. ` : "") +
            `Please update progress and submit TASK_REPORT with results[].outcome in IN_PROGRESS|BLOCKED_DEP|DONE|CANCELED for current work.`,
          reminder: {
            role,
            reminder_mode: reminderMode,
            reminder_count: reminderState.reminderCount,
            open_task_ids: roleOpenTasks.map((task) => task.taskId),
            open_task_titles: openTaskTitleItems,
            next_reminder_at: reminderState.nextReminderAt ?? null
          },
          taskHint: primaryTaskId ?? null
        }
      };

      await appendInboxMessage(paths, role, reminderMessage);
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "ORCHESTRATOR_ROLE_REMINDER_TRIGGERED",
        source: "manager",
        sessionId: idleSession.sessionId,
        taskId: primaryTaskId,
        payload: {
          requestId: reminderRequestId,
          messageId: reminderMessageId,
          role,
          reminderMode: reminderMode,
          reminderCount: reminderState.reminderCount,
          nextReminderAt: reminderState.nextReminderAt ?? null,
          openTaskIds: roleOpenTasks.map((task) => task.taskId),
          openTaskTitles: openTaskTitleItems
        }
      });

      const redispatchResult = await this.dispatchProject(project.projectId, {
        mode: "loop",
        sessionId: idleSession.sessionId,
        force: false,
        onlyIdle: false,
        maxDispatches: 1
      });
      const redispatchOutcome = redispatchResult.results[0]?.outcome ?? "no_message";
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "ORCHESTRATOR_ROLE_REMINDER_REDISPATCH",
        source: "manager",
        sessionId: idleSession.sessionId,
        taskId: primaryTaskId,
        payload: {
          role,
          outcome: redispatchOutcome
        }
      });

      logger.info(
        `[Orchestrator] checkIdleRoles: projectId=${project.projectId}, role=${role}, transition=${roleStateTransition}, sessionId=${idleSession.sessionId}, reminderMode=${reminderMode}, reminderCount=${reminderState.reminderCount}, nextReminderAt=${reminderState.nextReminderAt}, action=reminder_triggered`
      );
    }
  }

  private async checkAndMarkMayBeDone(project: ProjectRecord, paths: ProjectPaths): Promise<void> {
    const mayBeDoneEnabled = String(process.env.MAY_BE_DONE_ENABLED ?? "1").trim() !== "0";
    if (!mayBeDoneEnabled) {
      return;
    }

    const thresholdRaw = Number(process.env.MAY_BE_DONE_DISPATCH_THRESHOLD ?? MAY_BE_DONE_DISPATCH_THRESHOLD);
    const threshold =
      Number.isFinite(thresholdRaw) && thresholdRaw > 0 ? Math.floor(thresholdRaw) : MAY_BE_DONE_DISPATCH_THRESHOLD;
    const windowRaw = Number(process.env.MAY_BE_DONE_CHECK_WINDOW_MS ?? MAY_BE_DONE_CHECK_WINDOW_MS);
    const windowMs = Number.isFinite(windowRaw) && windowRaw > 0 ? Math.floor(windowRaw) : MAY_BE_DONE_CHECK_WINDOW_MS;

    const allTasks = await listTasks(paths, project.projectId);
    const nonTerminalTasks = allTasks.filter((t) => t.state !== "DONE" && t.state !== "CANCELED");
    if (nonTerminalTasks.length === 0) {
      return;
    }

    const events = await listEvents(paths);
    const now = Date.now();
    const cutoff = now - windowMs;
    const recentEvents = events.filter((e) => Date.parse(e.createdAt) >= cutoff);

    for (const task of nonTerminalTasks) {
      if (task.state === "MAY_BE_DONE") {
        // Already marked, skip logging and event
        continue;
      }

      const taskDispatchEvents = recentEvents.filter((e) => {
        if (e.taskId !== task.taskId || e.eventType !== "ORCHESTRATOR_DISPATCH_STARTED") {
          return false;
        }
        const payload = e.payload as Record<string, unknown>;
        const dispatchKind = payload.dispatchKind;
        return dispatchKind === "task";
      });
      const dispatchCount = taskDispatchEvents.length;

      if (dispatchCount < threshold) {
        continue;
      }

      const hasValidOutput = await this.hasValidAgentOutput(project, paths, task, recentEvents);
      if (!hasValidOutput) {
        continue;
      }

      await patchTask(paths, project.projectId, task.taskId, { state: "MAY_BE_DONE" });
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "TASK_MAY_BE_DONE_MARKED",
        source: "manager",
        taskId: task.taskId,
        payload: {
          dispatchCount,
          threshold,
          windowMs,
          reason: "dispatch_threshold_exceeded_with_valid_output"
        }
      });
      logger.info(
        `[Orchestrator] checkAndMarkMayBeDone: taskId=${task.taskId} marked as MAY_BE_DONE (dispatchCount=${dispatchCount})`
      );
    }
  }

  private async hasValidAgentOutput(
    project: ProjectRecord,
    paths: ProjectPaths,
    task: TaskRecord,
    recentEvents: EventRecord[]
  ): Promise<boolean> {
    if (task.lastSummary && task.lastSummary.trim().length > 0) {
      return true;
    }

    const runFinishedEvents = recentEvents.filter(
      (e) =>
        e.taskId === task.taskId && (e.eventType === "CODEX_RUN_FINISHED" || e.eventType === "MINIMAX_RUN_FINISHED")
    );
    for (const event of runFinishedEvents) {
      const payload = event.payload as Record<string, unknown>;
      const exitCode = payload.exitCode;
      if (typeof exitCode === "number" && exitCode === 0) {
        return true;
      }
    }

    if (task.ownerRole) {
      const progressFile = path.resolve(project.workspacePath, "Agents", task.ownerRole, "progress.md");
      try {
        const content = await fs.readFile(progressFile, "utf8");
        const normalized = content.replace(/^\uFEFF/, "").trim();
        if (normalized.length > 50) {
          return true;
        }
      } catch {
        // File doesn't exist or can't be read
      }
    }

    return false;
  }

  private async emitDispatchObservabilitySnapshot(project: ProjectRecord, paths: ProjectPaths): Promise<void> {
    const now = Date.now();
    const last = this.lastObservabilityEventAt.get(project.projectId) ?? 0;
    if (now - last < 60_000) {
      return;
    }
    const events = await listEvents(paths);
    const cutoff = now - 60 * 60 * 1000;
    const recent = events.filter((item) => Date.parse(item.createdAt) >= cutoff);
    const runStarted = recent.filter((item) => item.eventType === "CODEX_RUN_STARTED");
    const dispatchStarted = recent.filter((item) => item.eventType === "ORCHESTRATOR_DISPATCH_STARTED");
    const runByTaskSession = new Map<string, number>();
    for (const item of runStarted) {
      const key = `${item.taskId ?? ""}::${item.sessionId ?? ""}`;
      runByTaskSession.set(key, (runByTaskSession.get(key) ?? 0) + 1);
    }
    const duplicateRunTaskSessionCount = Array.from(runByTaskSession.values()).filter((n) => n > 1).length;
    await appendEvent(paths, {
      projectId: project.projectId,
      eventType: "ORCHESTRATOR_OBSERVABILITY_SNAPSHOT",
      source: "manager",
      payload: {
        windowMinutes: 60,
        codexRunStartedCount: runStarted.length,
        dispatchStartedCount: dispatchStarted.length,
        duplicateRunTaskSessionCount
      }
    });
    this.lastObservabilityEventAt.set(project.projectId, now);
  }
}

export function createOrchestratorService(dataRoot: string): OrchestratorService {
  const enabled = String(process.env.ORCHESTRATOR_ENABLED ?? "1").trim() !== "0";
  const intervalRaw = Number(process.env.ORCHESTRATOR_INTERVAL_MS ?? 10000);
  const intervalMs = Number.isFinite(intervalRaw) && intervalRaw > 500 ? intervalRaw : 10000;
  const maxConcurrentDispatchRaw = Number(process.env.ORCHESTRATOR_MAX_CONCURRENT_SESSIONS ?? 2);
  const maxConcurrentDispatches =
    Number.isFinite(maxConcurrentDispatchRaw) && maxConcurrentDispatchRaw > 0
      ? Math.floor(maxConcurrentDispatchRaw)
      : 2;
  const timeoutRaw = Number(process.env.SESSION_RUNNING_TIMEOUT_MS ?? 60000);
  const sessionRunningTimeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : 60000;
  const idleTimeoutRaw = Number(process.env.ORCHESTRATOR_IDLE_TIMEOUT_MS ?? 60000);
  const idleTimeoutMs = Number.isFinite(idleTimeoutRaw) && idleTimeoutRaw > 0 ? Math.floor(idleTimeoutRaw) : 60000;
  const reminderBackoffRaw = Number(process.env.ORCHESTRATOR_REMINDER_BACKOFF_MULTIPLIER ?? 2);
  const reminderBackoffMultiplier =
    Number.isFinite(reminderBackoffRaw) && reminderBackoffRaw > 1 ? reminderBackoffRaw : 2;
  const reminderMaxIntervalRaw = Number(process.env.ORCHESTRATOR_REMINDER_MAX_INTERVAL_MS ?? 1800000);
  const reminderMaxIntervalMs =
    Number.isFinite(reminderMaxIntervalRaw) && reminderMaxIntervalRaw > 0
      ? Math.floor(reminderMaxIntervalRaw)
      : 1800000;
  const reminderMaxCountRaw = Number(process.env.ORCHESTRATOR_REMINDER_MAX_COUNT ?? 5);
  const reminderMaxCount =
    Number.isFinite(reminderMaxCountRaw) && reminderMaxCountRaw >= 0 ? Math.floor(reminderMaxCountRaw) : 5;
  const autoReminderEnabled = String(process.env.ORCHESTRATOR_AUTO_REMINDER_ENABLED ?? "1").trim() !== "0";
  return new OrchestratorService({
    dataRoot,
    enabled,
    intervalMs,
    maxConcurrentDispatches,
    sessionRunningTimeoutMs,
    idleTimeoutMs,
    reminderBackoffMultiplier,
    reminderMaxIntervalMs,
    reminderMaxCount,
    autoReminderEnabled
  });
}
