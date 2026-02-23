import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../utils/logger.js";
import type { ManagerToAgentMessage, ProjectPaths, ProjectRecord, SessionRecord, TaskRecord } from "../domain/models.js";
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
import { addSession, getSession, listSessions, promotePendingSessionToCodex as promotePendingSessionToRealSessionId, touchSession } from "../data/session-store.js";
import {
  getTaskDependencyGateStatus,
  listRunnableTasksByRole,
  listTasks,
  patchTask
} from "../data/taskboard-store.js";
import { runModelForProject } from "./codex-runner.js";
import { cancelMiniMaxRunner, isMiniMaxRunnerActive, startMiniMaxForProject, registerMiniMaxCompletionCallback, unregisterMiniMaxCompletionCallback, registerMiniMaxWakeUpCallback, unregisterMiniMaxWakeUpCallback, type MiniMaxRunResultInternal } from "./minimax-runner.js";
import { ensureProjectAgentScripts } from "./project-agent-script-service.js";
import { ensureAgentWorkspaces } from "./agent-workspace-service.js";
import { buildProjectRoutingSnapshot, type ProjectRoutingSnapshot } from "./project-routing-snapshot-service.js";
import {
  getRoleMessageStatus,
  addPendingMessagesForRole,
  confirmPendingMessagesForRole
} from "../data/role-message-status-store.js";
import { getRoleReminderState, updateRoleReminderState } from "../data/role-reminder-store.js";

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
  const random = Math.random().toString(36).slice(2, 10);
  return `pending-${safeRole}-${random}`;
}

function isForceDispatchableState(state: string): boolean {
  return state === "READY" || state === "DISPATCHED" || state === "IN_PROGRESS" || state === "MAY_BE_DONE";
}

function sessionMatchesOwnerToken(session: SessionRecord, ownerSessionToken: string | undefined): boolean {
  if (!ownerSessionToken) {
    return false;
  }
  return session.sessionId === ownerSessionToken || session.sessionKey === ownerSessionToken;
}

function isTerminalTaskState(state: string): boolean {
  return state === "DONE" || state === "CANCELED";
}

/**
 * Check task dependency gate (self dependencies + ancestor-chain dependencies).
 */
function areTaskDependenciesSatisfied(task: TaskRecord, allTasks: TaskRecord[]): {
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

function extractTaskIdFromMessage(message: ManagerToAgentMessage): string | undefined {
  const payload = message.body ?? {};
  const fromPayload = payload.taskId;
  if (typeof fromPayload === "string" && fromPayload.trim().length > 0) {
    return fromPayload.trim();
  }
  return message.envelope.correlation.task_id;
}

function readMessageTypeUpper(message: ManagerToAgentMessage): string {
  const bodyType = (message.body as Record<string, unknown>).messageType;
  if (typeof bodyType === "string" && bodyType.trim().length > 0) {
    return bodyType.trim().toUpperCase();
  }
  const intent = message.envelope.intent;
  return typeof intent === "string" ? intent.toUpperCase() : "";
}

function isDiscussMessage(message: ManagerToAgentMessage): boolean {
  const type = readMessageTypeUpper(message);
  return type.startsWith("TASK_DISCUSS");
}

function isTaskAssignMessage(message: ManagerToAgentMessage): boolean {
  const type = readMessageTypeUpper(message);
  return type === "TASK_ASSIGNMENT";
}

function findCorrectTask(
  wrongTask: TaskRecord,
  targetRole: string,
  allTasks: TaskRecord[]
): TaskRecord | null {
  const childTasks = allTasks.filter(t =>
    t.parentTaskId === wrongTask.taskId &&
    t.state !== "CANCELED"
  );

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

  const wrongTask = allTasks.find(t => t.taskId === wrongTaskId);
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

  logger.info(`[resolveTaskDiscuss] Mapping discuss taskId from '${wrongTaskId}' to '${correctTask.taskId}' for targetRole='${targetRole}'`);

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

function sortMessagesByTime(messages: ManagerToAgentMessage[]): ManagerToAgentMessage[] {
  return [...messages].sort((a, b) => {
    const aTime = a.envelope.timestamp ? new Date(a.envelope.timestamp).getTime() : 0;
    const bTime = b.envelope.timestamp ? new Date(b.envelope.timestamp).getTime() : 0;
    return aTime - bTime;
  });
}

interface TaskDispatchSelection {
  taskId: string;
  messages: ManagerToAgentMessage[];
  dispatchKind: "task" | "message";
}

function selectTaskForDispatch(
  undeliveredMessages: ManagerToAgentMessage[],
  runnableTasks: TaskRecord[],
  allTasks: TaskRecord[]
): TaskDispatchSelection | null {
  const activeTaskStates = new Set(["DISPATCHED", "IN_PROGRESS"]);
  const runnableTaskIds = new Set(runnableTasks.map((task) => task.taskId));

  logger.info(
    `[selectTaskForDispatch] input: undeliveredMessages=${undeliveredMessages.length}, runnableTasks=${runnableTasks.length}, allTasks=${allTasks.length}`
  );

  const messagesByTask = new Map<string, ManagerToAgentMessage[]>();
  const messagesWithoutTask: ManagerToAgentMessage[] = [];

  for (const msg of undeliveredMessages) {
    const taskId = extractTaskIdFromMessage(msg);
    if (taskId) {
      if (!messagesByTask.has(taskId)) {
        messagesByTask.set(taskId, []);
      }
      messagesByTask.get(taskId)!.push(msg);
      continue;
    }
    messagesWithoutTask.push(msg);
  }

  logger.info(
    `[selectTaskForDispatch] messagesByTask keys: [${Array.from(messagesByTask.keys()).join(", ")}], messagesWithoutTask: ${messagesWithoutTask.length}`
  );

  for (const [taskId, messages] of messagesByTask) {
    const hasAssignTask = messages.some((m) => isTaskAssignMessage(m));
    const hasDiscuss = messages.some((m) => isDiscussMessage(m));

    if (hasAssignTask) {
      if (runnableTaskIds.has(taskId)) {
        logger.info(
          `[selectTaskForDispatch] selected: taskId=${taskId}, dispatchKind=task, reason=has_assign_task_and_runnable`
        );
        return { taskId, messages: sortMessagesByTime(messages), dispatchKind: "task" };
      }
      const referencedTask = allTasks.find((item) => item.taskId === taskId);
      if (referencedTask) {
        const depCheck = areTaskDependenciesSatisfied(referencedTask, allTasks);
        logger.info(
          `[selectTaskForDispatch] skipped assign: taskId=${taskId}, reason=task_not_runnable, blockingTaskIds=[${depCheck.blockingTaskIds.join(",")}], unsatisfiedDeps=[${depCheck.unsatisfiedDeps.join(",")}]`
        );
      } else {
        logger.info(`[selectTaskForDispatch] skipped assign: taskId=${taskId}, reason=task_not_found`);
      }
      continue;
    }

    if (hasDiscuss) {
      const task = allTasks.find((item) => item.taskId === taskId);
      if (task && activeTaskStates.has(task.state)) {
        logger.info(
          `[selectTaskForDispatch] selected: taskId=${taskId}, dispatchKind=message, reason=has_discuss_message_for_active_task`
        );
        return { taskId, messages: sortMessagesByTime(messages), dispatchKind: "message" };
      }
      logger.info(
        `[selectTaskForDispatch] skipped discuss: taskId=${taskId}, taskState=${task?.state ?? "not_found"}, reason=task_not_started`
      );
    }
  }

  const sortedTasks = [...runnableTasks].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  logger.info(
    `[selectTaskForDispatch] sortedTasks by createdAt: [${sortedTasks.map((task) => `${task.taskId}:${task.state}`).join(", ")}]`
  );

  for (const task of sortedTasks) {
    const messages = messagesByTask.get(task.taskId);
    if (messages && messages.length > 0) {
      const hasTaskAssign = messages.some((m) => isTaskAssignMessage(m));
      const dispatchKind: "task" | "message" = hasTaskAssign ? "task" : "message";
      logger.info(
        `[selectTaskForDispatch] selected: taskId=${task.taskId}, dispatchKind=${dispatchKind}, reason=has_${hasTaskAssign ? "task_assign" : "message"}_for_runnable_task`
      );
      return { taskId: task.taskId, messages: sortMessagesByTime(messages), dispatchKind };
    }
  }

  if (messagesWithoutTask.length > 0) {
    logger.info(
      `[selectTaskForDispatch] selected: taskId=(empty), dispatchKind=message, reason=messages_without_task`
    );
    return { taskId: "", messages: sortMessagesByTime(messagesWithoutTask), dispatchKind: "message" };
  }

  logger.info(`[selectTaskForDispatch] no selection: no messages and no runnable tasks with messages`);
  return null;
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
  const enabledAgents =
    routingSnapshot.enabledAgents.length > 0 ? routingSnapshot.enabledAgents.join(", ") : "(none)";

  const agentWorkspace = session.role
    ? `${project.workspacePath}/Agents/${session.role}`
    : project.workspacePath;

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
          lines.push(`- thread_id: ${discussContext.threadId}, round: ${discussContext.round}/${discussContext.maxRounds}, reply_to: ${reportTo?.role ?? "unknown"}`);
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
  lines.push("- if discuss is about task, read <YourWorkSpace>/progress.md for your progress. use <TeamWorkSpace>/TeamTools to report when you believe task is done.");
  lines.push("- **discuss_*.ps1 or discuss_*.bat in TeamTools is for clarification only; it does NOT count as task progress, MUST use report_task_* TeamTools to report task progress and completion.**");

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

function findLatestOpenDispatch(
  sessionEvents: EventRecord[]
): { event: EventRecord; dispatchId: string } | null {
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
}

async function handleMinMaxWakeUp(
  sessionId: string,
  context: MiniMaxLauncherContext
):Promise<void>{
  const { dataRoot, project, paths, session, taskId, dispatchId, dispatchKind, selectedMessageIds, firstMessage, startedAt, input } = context;
  await confirmPendingMessagesForRole(paths, project.projectId, session.role);
  let targetSessionIdForUpdate = session.sessionId;
  
  //promote minimax session id for role
  if (isPendingSessionId(session.sessionId) && sessionId !== session.sessionId) {
    const promoted = await promotePendingSessionToRealSessionId(paths, project.projectId, session.sessionId, sessionId);
    targetSessionIdForUpdate = promoted.sessionId;
    if (session.role) {
      await setRoleSessionMapping(dataRoot, project.projectId, session.role, promoted.sessionId);
    }
  }

  /** mark task dispatched */
  if (dispatchKind === "task" && taskId) {
    const allTasks = await listTasks(paths, project.projectId);
    const currentTask = allTasks.find(t => t.taskId === taskId);
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

  await touchSession(paths, project.projectId, targetSessionIdForUpdate, {
    status: "running",
    currentTaskId: taskId ?? session.currentTaskId ?? null,
    lastInboxMessageId: dispatchKind === "message" ? firstMessage.envelope.message_id : session.lastInboxMessageId ?? null,
    lastDispatchedAt: new Date().toISOString(),
    providerSessionId: session.providerSessionId,
    agentTool: "minimax",
    agentPid: null
  });

}



async function handleMiniMaxCompletion(
  result: MiniMaxRunResultInternal,
  sessionId: string,
  context: MiniMaxLauncherContext
): Promise<void> {
  const { dataRoot, project, paths, session, taskId, dispatchId, dispatchKind, selectedMessageIds, firstMessage, startedAt, input } = context;
  logger.info(`[handleMiniMaxCompletion] sessionId=${sessionId}, runId=${result.runId}, exitCode=${result.exitCode}, timedOut=${result.timedOut}`);
  const nextStatus = !result.timedOut && result.exitCode === 0 ? "idle" : "blocked";
  logger.info(`[handleMiniMaxCompletion] sessionId=${sessionId}, nextStatus=${nextStatus}`);  
 
  await touchSession(paths, project.projectId, sessionId, {
    status: nextStatus,
    currentTaskId: taskId ?? session.currentTaskId ?? null,
    lastInboxMessageId: dispatchKind === "message" ? firstMessage.envelope.message_id : session.lastInboxMessageId ?? null,
    lastDispatchedAt: new Date().toISOString(),
    providerSessionId: null,
    agentTool: "minimax",
    agentPid: null
  });
  
  await appendEvent(paths, {
    projectId: project.projectId,
    eventType: "ORCHESTRATOR_DISPATCH_FINISHED",
    source: "manager",
    sessionId: sessionId,
    taskId,
    payload: {
      dispatchId,
      mode: input.mode,
      dispatchKind,
      messageIds: selectedMessageIds,
      requestId: firstMessage.envelope.correlation.request_id,
      runId: result.runId,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      startedAt,
      finishedAt: result.finishedAt
    }
  });
  
  logger.info(`[handleMiniMaxCompletion] sessionId=${sessionId}, completed status update`);
}

const TERMINAL_TASK_STATES = new Set(["DONE", "CANCELED"]);

async function cleanupCompletedTaskMessages(
  paths: ProjectPaths,
  projectId: string,
  role: string
): Promise<number> {
  const allTasks = await listTasks(paths, projectId);
  const inboxMessages = await listInboxMessages(paths, role);
  
  const messagesToRemove: string[] = [];
  
  for (const msg of inboxMessages) {
    const taskId = extractTaskIdFromMessage(msg);
    if (taskId) {
      const task = allTasks.find(t => t.taskId === taskId);
      if (task && TERMINAL_TASK_STATES.has(task.state)) {
        messagesToRemove.push(msg.envelope.message_id);
      }
    }
  }
  
  if (messagesToRemove.length > 0) {
    const removed = await removeInboxMessages(paths, role, messagesToRemove);
    logger.info(`[cleanupCompletedTaskMessages] projectId=${projectId}, role=${role}, removed ${removed} messages for completed/canceled tasks`);
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
    const sampleFiltered = inboxMessages.slice(0, 3).map(item => ({
      id: item.envelope.message_id,
      confirmed: confirmedIds.has(item.envelope.message_id),
      pending: pendingIds.has(item.envelope.message_id)
    }));
    logger.info(`[dispatchSessionOnce] sessionId=${session.sessionId}, role=${session.role}, inbox sample (first 3): ${JSON.stringify(sampleFiltered)}`);
  }
  
  logger.info(`[dispatchSessionOnce] sessionId=${session.sessionId}, role=${session.role}, inboxCount=${inboxMessages.length}, confirmedCount=${confirmedIds.size}, pendingCount=${pendingIds.size}, undeliveredCount=${undeliveredMessages.length}`);

  const runnableByRole = await listRunnableTasksByRole(paths, project.projectId);
  const runnableTasks = runnableByRole.find((item) => item.role === session.role)?.tasks ?? [];
  // [DEBUG] Keep verbose state logs to diagnose why runnableTasks can be empty.
  const allTasks = await listTasks(paths, project.projectId);
  const tasksByState = allTasks.reduce((acc, task) => {
    acc[task.state] = (acc[task.state] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  logger.info(`[dispatchSessionOnce] sessionId=${session.sessionId}, role=${session.role}, tasksByState=${JSON.stringify(tasksByState)}, runnableByRole=${JSON.stringify(runnableByRole.map(r => ({ role: r.role, taskCount: r.tasks.length, taskIds: r.tasks.map(t => t.taskId) })))}, runnableTasks=${runnableTasks.length}`);

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

  logger.info(`[dispatchSessionOnce] sessionId=${session.sessionId}, role=${session.role}, session.status=${session.status}, dispatchKind=${dispatchKind}, selectedTaskId=${selectedTaskId}, messageCount=${selectedMessages.length}, onlyIdle=${input.onlyIdle}`);
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
  logger.info(`[dispatchSessionOnce] sessionId=${session.sessionId}, selectedMessageIds=${JSON.stringify(selectedMessageIds)}, lastInboxMessageId=${session.lastInboxMessageId ?? "null"}, force=${input.force}`);
  
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
  logger.info(`[dispatchSessionOnce] sessionId=${session.sessionId}, starting dispatch: dispatchId=${dispatchId}, dispatchKind=${dispatchKind}, messageIds=${JSON.stringify(selectedMessageIds)}`);

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

  await touchSession(paths, project.projectId, session.sessionId, {
    status: "running",
    currentTaskId: taskId ?? session.currentTaskId ?? null,
    agentPid: null
  });

  try {
    const routingSnapshot = buildProjectRoutingSnapshot(project, session.role, registeredAgentIds);
    const runtimeSettings = await getRuntimeSettings(dataRoot);
    const modelConfig = project.agentModelConfigs?.[session.role];
    const cliTool = modelConfig?.tool ?? "codex";
    if (cliTool !== "codex" && cliTool !== "trae" && cliTool !== "minimax") {
      throw new Error(`SESSION_PROVIDER_NOT_SUPPORTED: role '${session.role}' configured tool '${cliTool}'`);
    }
    const modelCommand = cliTool === "minimax" 
      ? undefined 
      : (cliTool === "trae" ? runtimeSettings.traeCliCommand : runtimeSettings.codexCliCommand);
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
      parent_request_id: firstMessage.envelope.correlation.parent_request_id ?? firstMessage.envelope.correlation.request_id,
      cli_tool: cliTool,
      model_command: modelCommand,
      model_params: Object.keys(modelParams).length > 0 ? modelParams : undefined,
      prompt
    };
    const resumeCandidate =
      session.providerSessionId?.trim() ||
      (!isPendingSessionId(session.sessionId) ? session.sessionId : "");
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
      
      registerMiniMaxWakeUpCallback(session.sessionId, async (sessionId) => {
        logger.info(`[dispatchSessionOnce] WakeUp callback triggered for sessionId=${sessionId}`);
        await handleMinMaxWakeUp(sessionId,launchContext)
       
      });
      
      registerMiniMaxCompletionCallback(session.sessionId, async (result, sessionId) => {
        try {
          await handleMiniMaxCompletion(result, sessionId, launchContext);
        } catch (error) {
          console.error(`[dispatchSessionOnce] MiniMax completion callback error:`, error);
          await touchSession(paths, project.projectId, session.sessionId, {
            status: "blocked",
            agentPid: null
          });
        }
      });
      
      const startResult = startMiniMaxForProject(project, paths, {
        sessionId: session.sessionId,
        prompt,
        taskId,
        activeTaskTitle,
        activeParentTaskId,
        activeRootTaskId,
        activeRequestId: firstMessage.envelope.correlation.request_id,
        agentRole: session.role,
        cliTool: "minimax",
        model: modelConfig?.model,
        modelParams
      }, runtimeSettings);
      
      logger.info(`[dispatchSessionOnce] sessionId=${session.sessionId}, MiniMax started async, runId=${startResult.runId}`);
      
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

    logger.info(`[dispatchSessionOnce] sessionId=${session.sessionId}, phase=runModelForProject START, cliTool=${cliTool}`);
    try {
      run = await runModelForProject(project, paths, {
        ...runBaseInput,
        resume_session_id: resumeCandidate
      }, runtimeSettings);
      logger.info(`[dispatchSessionOnce] sessionId=${session.sessionId}, phase=runModelForProject END, runId=${run?.runId}, exitCode=${run?.exitCode}`);
    } catch (error) {
      logger.info(`[dispatchSessionOnce] sessionId=${session.sessionId}, phase=runModelForProject ERROR: ${error instanceof Error ? error.message : String(error)}`);
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
          error: runError instanceof Error ? runError.message : (runError ? String(runError) : null)
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
      } catch (fallbackError) {
        runError = fallbackError;
      }
    }

    if (runError || !run) {
      throw runError instanceof Error ? runError : new Error(runError ? String(runError) : "model run failed");
    }

    const nextStatus = !run.timedOut && run.exitCode === 0 ? "idle" : "blocked";
    logger.info(`[dispatchSessionOnce] sessionId=${session.sessionId}, run completed: timedOut=${run.timedOut}, exitCode=${run.exitCode}, nextStatus=${nextStatus}`);
    const fallbackSessionIdBase = resumedFailedAndReset ? undefined : resumeCandidate || undefined;
    const nextProviderSessionId = run.sessionId ?? fallbackSessionIdBase;
    let targetSessionIdForUpdate = session.sessionId;
    if (run.sessionId && isPendingSessionId(session.sessionId) && run.sessionId !== session.sessionId) {
      const promoted = await promotePendingSessionToRealSessionId(paths, project.projectId, session.sessionId, run.sessionId);
      targetSessionIdForUpdate = promoted.sessionId;
      if (session.role) {
        await setRoleSessionMapping(dataRoot, project.projectId, session.role, promoted.sessionId);
      }
    }
    
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
      const currentTask = allTasks.find(t => t.taskId === taskId);
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

    await touchSession(paths, project.projectId, targetSessionIdForUpdate, {
      status: nextStatus,
      currentTaskId: taskId ?? session.currentTaskId ?? null,
      lastInboxMessageId: dispatchKind === "message" ? firstMessage.envelope.message_id : session.lastInboxMessageId ?? null,
      lastDispatchedAt: new Date().toISOString(),
      providerSessionId: nextProviderSessionId ?? null,
      agentTool: cliTool,
      agentPid: null
    });

    await appendEvent(paths, {
      projectId: project.projectId,
      eventType: "ORCHESTRATOR_DISPATCH_FINISHED",
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
        finishedAt: run.finishedAt
      }
    });

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
    await touchSession(paths, project.projectId, session.sessionId, {
      status: "blocked",
      agentPid: null
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
  private timer: NodeJS.Timeout | null = null;
  private tickRunning = false;
  private lastTickAt?: string;
  private readonly inFlightDispatchSessionKeys = new Set<string>();
  private readonly limitEventSent = new Set<string>();
  private readonly lastObservabilityEventAt = new Map<string, number>();

  constructor(private readonly options: OrchestratorOptions) {}

  async getStatus() {
    const projects = await listProjects(this.options.dataRoot);
    const perProject: Array<{
      projectId: string;
      autoDispatchEnabled: boolean;
      autoDispatchRemaining: number;
    }> = [];
    for (const item of projects) {
      const project = await getProject(this.options.dataRoot, item.projectId);
      perProject.push({
        projectId: project.projectId,
        autoDispatchEnabled: Boolean(project.autoDispatchEnabled ?? true),
        autoDispatchRemaining: Number(project.autoDispatchRemaining ?? 5)
      });
    }
    return {
      enabled: this.options.enabled,
      running: this.timer !== null,
      intervalMs: this.options.intervalMs,
      maxConcurrentDispatches: this.options.maxConcurrentDispatches,
      inFlightDispatchSessions: this.inFlightDispatchSessionKeys.size,
      lastTickAt: this.lastTickAt ?? null,
      projects: perProject
    };
  }

  private buildSessionDispatchKey(projectId: string, sessionId: string): string {
    return `${projectId}::${sessionId}`;
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
        proc.stdout?.on("data", (data) => { stdout += data.toString(); });
        proc.stderr?.on("data", (data) => { stderr += data.toString(); });
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
    unregisterMiniMaxCompletionCallback(session.sessionId);
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
    logger.info(`[dispatchSessionWithSingleFlight] added to inFlight: key=${key}, current inFlight=[${Array.from(this.inFlightDispatchSessionKeys).join(", ")}]`);
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
      logger.info(`[dispatchSessionWithSingleFlight] removed from inFlight: key=${key}, remaining inFlight=[${Array.from(this.inFlightDispatchSessionKeys).join(", ")}]`);
    }
  }

  start(): void {
    if (!this.options.enabled || this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tickLoop().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[orchestrator] tickLoop failed: ${message}`);
        this.lastTickAt = new Date().toISOString();
      });
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
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
        const activeOwnerSession =
          (targetTask.ownerSession ? selected.find((s) => sessionMatchesOwnerToken(s, targetTask.ownerSession)) : undefined) ??
          selected.find((s) => s.role === targetTask.ownerRole && s.status !== "dismissed");
        if (activeOwnerSession && activeOwnerSession.status !== "dismissed") {
          input.sessionId = activeOwnerSession.sessionId;
        } else {
          const newSessionId = buildPendingSessionId(targetTask.ownerRole);
          const ownerAgentTool = project.agentModelConfigs?.[targetTask.ownerRole]?.tool ?? "codex";
          const created = await addSession(paths, project.projectId, {
            sessionId: newSessionId,
            sessionKey: newSessionId,
            role: targetTask.ownerRole,
            status: "idle",
            provider: "codex",
            providerSessionId: undefined,
            agentTool: ownerAgentTool as "codex" | "trae" | "minimax"
          });
          await patchTask(paths, project.projectId, targetTask.taskId, {
            ownerSession: created.session.sessionId
          });
          await setRoleSessionMapping(this.options.dataRoot, project.projectId, targetTask.ownerRole, created.session.sessionId);
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

    const orderedSessions =
      mode === "loop" && !input.sessionId
        ? [...effectiveSelected].sort((a, b) => {
            const aKey = Date.parse(a.lastDispatchedAt ?? a.lastActiveAt ?? a.createdAt);
            const bKey = Date.parse(b.lastDispatchedAt ?? b.lastActiveAt ?? b.createdAt);
            if (aKey !== bKey) {
              return aKey - bKey;
            }
            return a.sessionId.localeCompare(b.sessionId);
          })
        : [...effectiveSelected];
    
    logger.info(`[dispatchProject] projectId=${projectId}, mode=${mode}, orderedSessions=${orderedSessions.length}, sessions=[${orderedSessions.map(s => `${s.sessionId}:${s.role}:${s.status}`).join(", ")}]`);
    logger.info(`[dispatchProject] inFlightSessionKeys: [${Array.from(this.inFlightDispatchSessionKeys).join(", ")}]`);
    
    if (input.sessionId && orderedSessions.length === 0) {
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

    const maxDispatches =
      typeof input.maxDispatches === "number" && Number.isFinite(input.maxDispatches) && input.maxDispatches > 0
        ? Math.floor(input.maxDispatches)
        : Number.POSITIVE_INFINITY;

    const results: SessionDispatchResult[] = [];
    let dispatchedCount = 0;
    const rolesWithMessages = new Map<string, string[]>();
    const dispatchedRoles = new Set<string>();
    
    for (let i = 0; i < orderedSessions.length; i++) {
      if (dispatchedCount >= maxDispatches) {
        logger.info(`[dispatchProject] reached maxDispatches=${maxDispatches}, breaking loop`);
        break;
      }
      const session = orderedSessions[i];
      logger.info(`[dispatchProject] processing session[${i}]: ${session.sessionId}, role=${session.role}, status=${session.status}`);
      const freshSession = await getSession(paths, project.projectId, session.sessionId);
      if (!freshSession) {
        logger.info(`[dispatchProject] skip: session ${session.sessionId} not found`);
        continue;
      }
      orderedSessions[i] = freshSession;
      
      if (freshSession.status === "dismissed" && !dispatchedRoles.has(freshSession.role)) {
        const inboxMessages = await listInboxMessages(paths, freshSession.role);
        const roleStatus = getRoleMessageStatus(project, freshSession.role);
        const confirmedIds = new Set(roleStatus.confirmedMessageIds);
        const pendingIds = new Set(roleStatus.pendingConfirmedMessages.map((p) => p.messageId));
        const undelivered = inboxMessages.filter(
          (item) => !confirmedIds.has(item.envelope.message_id) && !pendingIds.has(item.envelope.message_id)
        );
        if (undelivered.length > 0) {
          logger.info(`[dispatchProject] dismissed session ${freshSession.sessionId} has ${undelivered.length} undelivered messages, recording for role=${freshSession.role}`);
          rolesWithMessages.set(freshSession.role, undelivered.map((m) => m.envelope.message_id));
        }
      }
      
      if (dispatchedRoles.has(freshSession.role)) {
        logger.info(`[dispatchProject] skip: role=${freshSession.role} already dispatched in this cycle`);
        continue;
      }
      
      const row = await this.dispatchSessionWithSingleFlight(
        project,
        paths,
        freshSession,
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
      logger.info(`[dispatchProject] dispatch result: sessionId=${freshSession.sessionId}, outcome=${row.outcome}, dispatchKind=${row.dispatchKind}, reason=${row.reason ?? "none"}`);
      if (row.outcome === "dispatched") {
        dispatchedCount += 1;
        dispatchedRoles.add(freshSession.role);
        rolesWithMessages.delete(freshSession.role);
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

    for (const [role, messageIds] of rolesWithMessages) {
      if (dispatchedRoles.has(role) || dispatchedCount >= maxDispatches) {
        continue;
      }
      
      const runningSession = orderedSessions.find((s) => s.role === role && s.status === "running");
      if (runningSession) {
        const isActive = isMiniMaxRunnerActive(runningSession.sessionId);
        if (isActive) {
          logger.info(`[dispatchProject] role=${role} has running session ${runningSession.sessionId}, skipping`);
          continue;
        }
        logger.info(`[dispatchProject] role=${role} has stale running session ${runningSession.sessionId}, cleaning up`);
        await touchSession(paths, project.projectId, runningSession.sessionId, { 
          status: "dismissed", 
          agentPid: null 
        });
      }
      
      const activeSession = orderedSessions.find((s) => s.role === role && s.status === "idle");
      const blockedSession = orderedSessions.find((s) => s.role === role && s.status === "blocked");
      if (!activeSession && !blockedSession) {
        logger.info(`[dispatchProject] role=${role} has ${messageIds.length} messages but no active session, creating new session`);
        const newSessionId = buildPendingSessionId(role);
        const agentTool = project.agentModelConfigs?.[role]?.tool ?? "codex";
        const created = await addSession(paths, project.projectId, {
          sessionId: newSessionId,
          sessionKey: newSessionId,
          role: role,
          status: "idle",
          provider: "codex",
          providerSessionId: undefined,
          agentTool: agentTool as "codex" | "trae" | "minimax"
        });
        await setRoleSessionMapping(this.options.dataRoot, project.projectId, role, created.session.sessionId);
        await appendEvent(paths, {
          projectId: project.projectId,
          eventType: "SESSION_AUTO_BOOTSTRAPPED_FOR_MESSAGE",
          source: "manager",
          sessionId: created.session.sessionId,
          payload: {
            role: role,
            messageIds: messageIds,
            reason: "no_active_session_for_role"
          }
        });
        const row = await this.dispatchSessionWithSingleFlight(
          project,
          paths,
          created.session,
          {
            mode,
            force: false,
            onlyIdle: true,
            messageId: undefined,
            taskId: undefined
          },
          rolePromptMap,
          registeredAgentIds
        );
        results.push(row);
        if (row.outcome === "dispatched") {
          dispatchedCount += 1;
          dispatchedRoles.add(role);
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

      await this.terminateSessionProcessInternal(project, paths, session, "session_heartbeat_timeout");

      const sessionEvents = events.filter((item) => item.sessionId === session.sessionId);
      const openDispatch = findLatestOpenDispatch(sessionEvents);
      if (openDispatch) {
        const payload = openDispatch.event.payload as Record<string, unknown>;
        await appendEvent(paths, {
          projectId: project.projectId,
          eventType: "ORCHESTRATOR_DISPATCH_FAILED",
          source: "manager",
          sessionId: session.sessionId,
          taskId: session.currentTaskId ?? openDispatch.event.taskId,
          payload: {
            dispatchId: openDispatch.dispatchId,
            mode: payload.mode ?? "loop",
            dispatchKind: payload.dispatchKind ?? "task",
            messageId: payload.messageId ?? null,
            requestId: payload.requestId ?? null,
            error: "session heartbeat timeout"
          }
        });
      }

      const openRun = findLatestOpenRun(sessionEvents);
      if (openRun) {
        const payload = openRun.event.payload as Record<string, unknown>;
        await appendEvent(paths, {
          projectId: project.projectId,
          eventType: "CODEX_RUN_FINISHED",
          source: "manager",
          sessionId: session.sessionId,
          taskId: session.currentTaskId ?? openRun.event.taskId,
          payload: {
            runId: openRun.runId,
            exitCode: null,
            timedOut: true,
            status: "timeout",
            agentTool: payload.agentTool ?? session.agentTool ?? null,
            mode: payload.mode ?? "exec",
            providerSessionId: payload.providerSessionId ?? session.providerSessionId ?? session.sessionId ?? null,
            synthetic: true,
            reason: "session_heartbeat_timeout"
          }
        });
      }

      await touchSession(paths, project.projectId, session.sessionId, { status: "dismissed", agentPid: null });
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "SESSION_HEARTBEAT_TIMEOUT",
        source: "manager",
        sessionId: session.sessionId,
        taskId: session.currentTaskId,
        payload: {
          previousStatus: "running",
          timeoutMs: this.options.sessionRunningTimeoutMs,
          lastActiveAt: session.lastActiveAt
        }
      });

      const remaining = Number(project.autoDispatchRemaining ?? 5);
      const enabled = project.autoDispatchEnabled ?? true;
      if (enabled && remaining > 0 && session.currentTaskId) {
        logger.info(`[Orchestrator] markTimedOutSessions: sessionId=${session.sessionId}, projectId=${project.projectId}, remaining=${remaining}, willAutoRedispatch=true`);
        const allTasks = await listTasks(paths, project.projectId);
        const currentTask = allTasks.find((t) => t.taskId === session.currentTaskId);
        if (currentTask && currentTask.state !== "DONE" && sessionMatchesOwnerToken(session, currentTask.ownerSession)) {
          await appendEvent(paths, {
            projectId: project.projectId,
            eventType: "ORCHESTRATOR_AUTO_REDISPATCH_TRIGGERED",
            source: "manager",
            sessionId: session.sessionId,
            taskId: session.currentTaskId,
            payload: {
              reason: "heartbeat_timeout_auto_redispatch",
              autoDispatchRemaining: remaining
            }
          });
          await touchSession(paths, project.projectId, session.sessionId, { status: "idle", agentPid: null });
          const redispatchResult = await this.dispatchProject(project.projectId, {
            mode: "loop",
            sessionId: session.sessionId,
            taskId: session.currentTaskId,
            force: true,
            onlyIdle: false,
            maxDispatches: 1
          });
          const redispatched = redispatchResult.results.find((r) => r.outcome === "dispatched");
          if (redispatched) {
            const newRemaining = Math.max(0, remaining - 1);
            logger.info(`[Orchestrator] markTimedOutSessions: auto-redispatch succeeded, updating autoDispatchRemaining from ${remaining} to ${newRemaining}`);
            await updateProjectOrchestratorSettings(this.options.dataRoot, project.projectId, {
              autoDispatchRemaining: newRemaining
            });
          }
        }
      }
    }
  }

  private async tickLoop(): Promise<void> {
    logger.info(`[Orchestrator] tickLoop start: enabled=${this.options.enabled}, tickRunning=${this.tickRunning}, inFlightCount=${this.inFlightDispatchSessionKeys.size}`);
    if (!this.options.enabled || this.tickRunning) {
      logger.info(`[Orchestrator] tickLoop skip: enabled=${this.options.enabled}, tickRunning=${this.tickRunning}`);
      return;
    }
    this.tickRunning = true;
    try {
      const projects = await listProjects(this.options.dataRoot);
      logger.info(`[Orchestrator] tickLoop: found ${projects.length} projects`);
      for (const item of projects) {
        const project = await getProject(this.options.dataRoot, item.projectId);
        const paths = await ensureProjectRuntime(this.options.dataRoot, project.projectId);
        
        logger.info(`[Orchestrator] tickLoop: processing projectId=${project.projectId}, autoDispatchEnabled=${project.autoDispatchEnabled}, autoDispatchRemaining=${project.autoDispatchRemaining}`);
        
        await this.markTimedOutSessions(project, paths);

        await this.checkIdleRoles(project, paths);

        await this.checkAndMarkMayBeDone(project, paths);

        await this.emitDispatchObservabilitySnapshot(project, paths);

        const enabled = project.autoDispatchEnabled ?? true;
        const remaining = Number(project.autoDispatchRemaining ?? 5);
        if (!enabled) {
          logger.info(`[Orchestrator] tickLoop: projectId=${project.projectId} autoDispatch disabled, skipping`);
          continue;
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
          continue;
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
        logger.info(`[Orchestrator] tickLoop: projectId=${project.projectId}, remaining=${remaining}, results=${result.results.length}, consumed=${consumed}, outcomes=[${result.results.map(r => `${r.sessionId}:${r.outcome}:${r.dispatchKind}`).join(", ")}]`);
        if (consumed > 0) {
          const newRemaining = Math.max(0, remaining - consumed);
          logger.info(`[Orchestrator] tickLoop: updating autoDispatchRemaining from ${remaining} to ${newRemaining}`);
          await updateProjectOrchestratorSettings(this.options.dataRoot, project.projectId, {
            autoDispatchRemaining: newRemaining
          });
        }
      }
      this.lastTickAt = new Date().toISOString();
    } finally {
      this.tickRunning = false;
    }
  }

  /**
   * Check idle roles and manage reminder timing with exponential backoff.
   * Implements: nextReminderAt = now + min(initialWaitMs * (backoffMultiplier ^ reminderCount), maxWaitMs)
   */
  private async checkIdleRoles(project: ProjectRecord, paths: ProjectPaths): Promise<void> {
    // Check if auto reminder is enabled
    // Project-level setting takes precedence: if explicitly false, skip
    // If undefined or true, use orchestrator-level setting (default: true)
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

    // Get config values with defaults
    const maxRetries = this.options.reminderMaxCount ?? 5;
    const backoffMultiplier = this.options.reminderBackoffMultiplier ?? 2;
    const maxIntervalMs = this.options.reminderMaxIntervalMs ?? 1800000;

    // Group sessions by role and get latest session for each role
    const roleToSession = new Map<string, SessionRecord>();
    for (const session of sessions) {
      const existing = roleToSession.get(session.role);
      if (!existing) {
        roleToSession.set(session.role, session);
        continue;
      }
      // Prefer idle/dismissed over running/blocked, then by most recent update
      const existingIsIdle = existing.status === "idle" || existing.status === "dismissed";
      const currentIsIdle = session.status === "idle" || session.status === "dismissed";
      if (currentIsIdle && !existingIsIdle) {
        roleToSession.set(session.role, session);
      } else if (existingIsIdle === currentIsIdle) {
        const existingTime = Date.parse(existing.updatedAt);
        const currentTime = Date.parse(session.updatedAt);
        if (currentTime > existingTime) {
          roleToSession.set(session.role, session);
        }
      }
    }

    for (const [role, session] of roleToSession) {
      const isIdle = session.status === "idle";
      if (!isIdle) {
        continue;
      }

      const roleOpenTasks = allTasks
        .filter((task) => task.ownerRole === role && !isTerminalTaskState(task.state))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const hasOpenTask = roleOpenTasks.length > 0;

      // Get or create role reminder state
      let reminderState = await getRoleReminderState(paths, project.projectId, role);
      const sessionIdleSince = session.idleSince ?? session.lastDispatchedAt ?? session.updatedAt;

      if (!reminderState) {
        // Create new reminder state for this role
        reminderState = await updateRoleReminderState(paths, project.projectId, role, {
          idleSince: sessionIdleSince,
          reminderCount: 0,
          lastSessionId: session.sessionId
        });
        logger.info(`[Orchestrator] checkIdleRoles: projectId=${project.projectId}, role=${role}, sessionId=${session.sessionId}, status=${session.status}, idleSince=${sessionIdleSince}, action=created`);
      } else {
        // Update if session changed or idleSince not set
        const needsUpdate = !reminderState.idleSince || reminderState.lastSessionId !== session.sessionId;

        // Check if we need to trigger the next reminder based on exponential backoff
        const nextReminderTime = reminderState.nextReminderAt ? Date.parse(reminderState.nextReminderAt) : 0;

        if (reminderState.reminderCount < maxRetries && nowMs >= nextReminderTime && reminderState.idleSince) {
          if (!hasOpenTask) {
            reminderState = await updateRoleReminderState(paths, project.projectId, role, {
              reminderCount: 0,
              nextReminderAt: undefined
            });
            logger.info(
              `[Orchestrator] checkIdleRoles: projectId=${project.projectId}, role=${role}, sessionId=${session.sessionId}, action=reminder_skipped_no_open_task`
            );
            continue;
          }

          // Time to trigger next reminder - calculate using exponential backoff
          const nextReminderAt = calculateNextReminderTime(reminderState.reminderCount, nowMs, {
            initialWaitMs: this.options.idleTimeoutMs,
            backoffMultiplier,
            maxWaitMs: maxIntervalMs
          });

          reminderState = await updateRoleReminderState(paths, project.projectId, role, {
            reminderCount: reminderState.reminderCount + 1,
            nextReminderAt
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
                `Please update progress and submit TASK_REPORT (IN_PROGRESS or DONE/BLOCKED) for current work.`,
              reminder: {
                role,
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
            sessionId: session.sessionId,
            taskId: primaryTaskId,
            payload: {
              requestId: reminderRequestId,
              messageId: reminderMessageId,
              role,
              reminderCount: reminderState.reminderCount,
              nextReminderAt: reminderState.nextReminderAt ?? null,
              openTaskIds: roleOpenTasks.map((task) => task.taskId),
              openTaskTitles: openTaskTitleItems
            }
          });

          const redispatchResult = await this.dispatchProject(project.projectId, {
            mode: "loop",
            sessionId: session.sessionId,
            force: false,
            onlyIdle: false,
            maxDispatches: 1
          });
          const redispatchOutcome = redispatchResult.results[0]?.outcome ?? "no_message";
          await appendEvent(paths, {
            projectId: project.projectId,
            eventType: "ORCHESTRATOR_ROLE_REMINDER_REDISPATCH",
            source: "manager",
            sessionId: session.sessionId,
            taskId: primaryTaskId,
            payload: {
              role,
              outcome: redispatchOutcome
            }
          });

          logger.info(`[Orchestrator] checkIdleRoles: projectId=${project.projectId}, role=${role}, sessionId=${session.sessionId}, status=${session.status}, idleSince=${reminderState.idleSince}, reminderCount=${reminderState.reminderCount}, nextReminderAt=${reminderState.nextReminderAt}, action=reminder_triggered`);
        } else if (needsUpdate) {
          reminderState = await updateRoleReminderState(paths, project.projectId, role, {
            idleSince: sessionIdleSince,
            lastSessionId: session.sessionId
          });
          logger.info(`[Orchestrator] checkIdleRoles: projectId=${project.projectId}, role=${role}, sessionId=${session.sessionId}, status=${session.status}, idleSince=${sessionIdleSince}, action=updated`);
        } else if (reminderState.reminderCount >= maxRetries) {
          // Max retries reached, log and skip
          logger.info(`[Orchestrator] checkIdleRoles: projectId=${project.projectId}, role=${role}, sessionId=${session.sessionId}, status=${session.status}, idleSince=${reminderState.idleSince}, reminderCount=${reminderState.reminderCount}, action=max_retries_reached`);
        } else {
          // Log detection even if no update needed
          const idleDurationMs = nowMs - Date.parse(reminderState.idleSince ?? now);
          const idleDurationMinutes = Math.floor(idleDurationMs / 60000);
          logger.info(`[Orchestrator] checkIdleRoles: projectId=${project.projectId}, role=${role}, sessionId=${session.sessionId}, status=${session.status}, idleSince=${reminderState.idleSince}, idleDurationMinutes=${idleDurationMinutes}, action=detected`);
        }
      }
    }
  }


  private async checkAndMarkMayBeDone(project: ProjectRecord, paths: ProjectPaths): Promise<void> {
    const mayBeDoneEnabled = String(process.env.MAY_BE_DONE_ENABLED ?? "1").trim() !== "0";
    if (!mayBeDoneEnabled) {
      return;
    }

    const thresholdRaw = Number(process.env.MAY_BE_DONE_DISPATCH_THRESHOLD ?? MAY_BE_DONE_DISPATCH_THRESHOLD);
    const threshold = Number.isFinite(thresholdRaw) && thresholdRaw > 0 ? Math.floor(thresholdRaw) : MAY_BE_DONE_DISPATCH_THRESHOLD;
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

      const taskDispatchEvents = recentEvents.filter(
        (e) => {
          if (e.taskId !== task.taskId || e.eventType !== "ORCHESTRATOR_DISPATCH_STARTED") {
            return false;
          }
          const payload = e.payload as Record<string, unknown>;
          const dispatchKind = payload.dispatchKind;
          return dispatchKind === "task";
        }
      );
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
      logger.info(`[Orchestrator] checkAndMarkMayBeDone: taskId=${task.taskId} marked as MAY_BE_DONE (dispatchCount=${dispatchCount})`);
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
        e.taskId === task.taskId &&
        (e.eventType === "CODEX_RUN_FINISHED" || e.eventType === "MINIMAX_RUN_FINISHED")
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
  const sessionRunningTimeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : 60000;
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

