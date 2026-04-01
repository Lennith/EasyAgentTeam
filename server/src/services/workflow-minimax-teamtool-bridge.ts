import path from "node:path";
import { listWorkflowSessions } from "../data/workflow-run-store.js";
import {
  acquireLock,
  createWorkflowRunLockScope,
  listActiveLocks,
  releaseLock,
  renewLock
} from "../data/lock-store.js";
import { isManagerChatMessageType } from "../domain/models.js";
import type {
  ProjectPaths,
  ProjectRecord,
  WorkflowRunRecord,
  WorkflowTaskActionRequest,
  WorkflowTaskActionType,
  WorkflowTaskOutcome
} from "../domain/models.js";
import type { TeamToolBridge, TeamToolExecutionContext } from "../minimax/tools/team/types.js";
import { normalizeOrchestratorDiscussReference } from "./orchestrator/shared/index.js";
import type { WorkflowRouteMessageInput } from "./orchestrator/workflow-message-routing-service.js";
import { resolveDiscussRoundLimit } from "./discuss-policy-service.js";
import { TeamToolBridgeError } from "./minimax-teamtool-bridge.js";
import { resolveWorkflowRunRoleScope } from "./workflow-role-scope-service.js";

export { TeamToolBridgeError } from "./minimax-teamtool-bridge.js";

interface WorkflowTaskActionDefaults {
  agentRole: string;
  sessionId: string;
  activeTaskId?: string;
  parentRequestId?: string;
}

export type WorkflowBridgeSendMessageInput = Omit<WorkflowRouteMessageInput, "runId">;

export interface WorkflowMiniMaxTeamToolBridgeContext {
  dataRoot: string;
  run: WorkflowRunRecord;
  agentRole: string;
  sessionId: string;
  activeTaskId?: string;
  activeRequestId?: string;
  parentRequestId?: string;
  applyTaskAction: (request: WorkflowTaskActionRequest) => Promise<Record<string, unknown>>;
  sendRunMessage: (input: WorkflowBridgeSendMessageInput) => Promise<Record<string, unknown>>;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readStringList(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((item) => String(item).trim()).filter((item) => item.length > 0);
  }
  if (typeof input === "string") {
    return input
      .split(/[,\n\r|]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

function readTaskOutcome(input: unknown): WorkflowTaskOutcome | null {
  const raw = readString(input);
  if (raw === "IN_PROGRESS" || raw === "BLOCKED_DEP" || raw === "MAY_BE_DONE" || raw === "DONE" || raw === "CANCELED") {
    return raw;
  }
  return null;
}

function readToRole(body: Record<string, unknown>): string | undefined {
  const direct = readString(body.to_role ?? body.toRole);
  if (direct) {
    return direct;
  }
  const to = readRecord(body.to);
  return readString(to?.agent ?? to?.role);
}

function readToSessionId(body: Record<string, unknown>): string | undefined {
  const direct = readString(body.to_session_id ?? body.toSessionId);
  if (direct) {
    return direct;
  }
  const to = readRecord(body.to);
  return readString(to?.session_id ?? to?.sessionId);
}

function mapTaskCreatePayload(
  body: Record<string, unknown>,
  defaults: WorkflowTaskActionDefaults
): WorkflowTaskActionRequest | null {
  const taskBody = readRecord(body.task) ?? body;
  const taskId = readString(taskBody.task_id ?? taskBody.taskId);
  const title = readString(taskBody.title);
  const ownerRole = readString(taskBody.owner_role ?? taskBody.ownerRole);
  if (!taskId || !title || !ownerRole) {
    return null;
  }

  return {
    actionType: "TASK_CREATE",
    fromAgent: readString(body.from_agent ?? body.fromAgent) ?? defaults.agentRole,
    fromSessionId: readString(body.from_session_id ?? body.fromSessionId) ?? defaults.sessionId,
    taskId: defaults.activeTaskId,
    task: {
      taskId,
      title,
      ownerRole,
      parentTaskId: readString(taskBody.parent_task_id ?? taskBody.parentTaskId) ?? defaults.activeTaskId,
      dependencies: readStringList(taskBody.dependencies),
      acceptance: readStringList(taskBody.acceptance),
      artifacts: readStringList(taskBody.artifacts)
    }
  };
}

function mapTaskReportPayload(
  body: Record<string, unknown>,
  defaults: WorkflowTaskActionDefaults
): WorkflowTaskActionRequest | null {
  const resultsRaw = Array.isArray(body.results) ? body.results : [];
  const results = resultsRaw
    .map((item) => {
      const row = readRecord(item);
      if (!row) {
        return null;
      }
      const taskId = readString(row.task_id ?? row.taskId);
      const outcome = readTaskOutcome(row.outcome);
      if (!taskId || !outcome) {
        return null;
      }
      return {
        taskId,
        outcome,
        summary: readString(row.summary),
        blockers: readStringList(row.blockers)
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  if (results.length === 0) {
    return null;
  }

  return {
    actionType: "TASK_REPORT",
    fromAgent: readString(body.from_agent ?? body.fromAgent) ?? defaults.agentRole,
    fromSessionId: readString(body.from_session_id ?? body.fromSessionId) ?? defaults.sessionId,
    taskId: readString(body.task_id ?? body.taskId) ?? defaults.activeTaskId,
    results
  };
}

function mapDiscussPayload(
  actionType: WorkflowTaskActionType,
  body: Record<string, unknown>,
  defaults: WorkflowTaskActionDefaults
): WorkflowTaskActionRequest | null {
  const taskId = readString(body.task_id ?? body.taskId) ?? defaults.activeTaskId;
  const content = readString(body.content ?? body.message) ?? "";
  const toRole = readToRole(body);
  const toSessionId = readToSessionId(body);
  if (!taskId || (!toRole && !toSessionId)) {
    return null;
  }
  const discuss = readRecord(body.discuss);
  return {
    actionType,
    fromAgent: readString(body.from_agent ?? body.fromAgent) ?? defaults.agentRole,
    fromSessionId: readString(body.from_session_id ?? body.fromSessionId) ?? defaults.sessionId,
    toRole,
    toSessionId,
    taskId,
    content,
    discuss: {
      threadId: readString(discuss?.thread_id ?? discuss?.threadId),
      requestId: readString(discuss?.request_id ?? discuss?.requestId) ?? readString(body.request_id ?? body.requestId)
    }
  };
}

function mapWorkflowTaskActionRequest(
  requestBody: Record<string, unknown>,
  defaults: WorkflowTaskActionDefaults
): WorkflowTaskActionRequest | null {
  const actionType = readString(requestBody.action_type ?? requestBody.actionType);
  if (actionType === "TASK_CREATE") {
    return mapTaskCreatePayload(requestBody, defaults);
  }
  if (actionType === "TASK_REPORT") {
    return mapTaskReportPayload(requestBody, defaults);
  }
  if (actionType === "TASK_DISCUSS_REQUEST") {
    return mapDiscussPayload("TASK_DISCUSS_REQUEST", requestBody, defaults);
  }
  if (actionType === "TASK_DISCUSS_REPLY") {
    return mapDiscussPayload("TASK_DISCUSS_REPLY", requestBody, defaults);
  }
  if (actionType === "TASK_DISCUSS_CLOSED") {
    return mapDiscussPayload("TASK_DISCUSS_CLOSED", requestBody, defaults);
  }
  return null;
}

function resolveTaskActionNextAction(code: string): string | null {
  switch (code) {
    case "INVALID_TRANSITION":
      return "Fix task action payload (task/report/discuss fields) and retry once.";
    case "TASK_NOT_FOUND":
      return "Re-check task_id/parent_task_id/to_role and retry.";
    case "TASK_OWNER_ROLE_NOT_FOUND":
      return "Call route_targets_get first, choose an allowed target role, and retry TASK_CREATE.";
    case "TASK_DEPENDENCY_NOT_READY":
      return "Wait for dependency tasks listed in error.details.dependency_task_ids to reach DONE/CANCELED, then retry.";
    case "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN":
      return "Remove parent/ancestor task ids from dependencies and retry TASK_CREATE.";
    case "RUN_NOT_RUNNING":
      return "Run is not active. Restart run before sending task actions.";
    case "ROUTE_DENIED":
      return "Choose an allowed target from route_targets_get before discussing.";
    default:
      return null;
  }
}

function resolveMessageNextAction(code: string): string | null {
  switch (code) {
    case "MESSAGE_TARGET_REQUIRED":
      return "Provide to_role or to_session_id.";
    case "ROUTE_DENIED":
      return "Choose an allowed target from route_targets_get.";
    case "TASK_NOT_FOUND":
      return "Re-check task_id and discussion thread binding.";
    default:
      return null;
  }
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function asStatus(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 100 && value <= 599) {
    return Math.floor(value);
  }
  return fallback;
}

function asCode(value: unknown, fallback: string): string {
  const code = readString(value);
  return code ?? fallback;
}

function uniq(items: string[]): string[] {
  return Array.from(new Set(items));
}

function resolveRootTaskId(run: WorkflowRunRecord, taskId: string | undefined): string | undefined {
  const currentId = taskId?.trim();
  if (!currentId) {
    return undefined;
  }
  const byId = new Map(run.tasks.map((task) => [task.taskId, task]));
  let cursor = byId.get(currentId);
  if (!cursor) {
    return undefined;
  }
  while (cursor?.parentTaskId) {
    const next = byId.get(cursor.parentTaskId);
    if (!next) {
      break;
    }
    cursor = next;
  }
  return cursor.taskId;
}

export function buildWorkflowTeamToolContext(context: WorkflowMiniMaxTeamToolBridgeContext): TeamToolExecutionContext {
  const pseudoProjectId = `workflow-${context.run.runId}`;
  const now = new Date().toISOString();
  const project: ProjectRecord = {
    schemaVersion: "1.0",
    projectId: pseudoProjectId,
    name: `Workflow ${context.run.runId}`,
    workspacePath: context.run.workspacePath,
    routeTable: context.run.routeTable,
    taskAssignRouteTable: context.run.taskAssignRouteTable,
    routeDiscussRounds: context.run.routeDiscussRounds,
    autoDispatchEnabled: false,
    autoDispatchRemaining: 0,
    createdAt: context.run.createdAt ?? now,
    updatedAt: context.run.updatedAt ?? now
  };

  const bridgeRoot = path.join(context.run.workspacePath, ".minimax", "teamtools", context.run.runId);
  const paths: ProjectPaths = {
    projectRootDir: bridgeRoot,
    projectConfigFile: path.join(bridgeRoot, "project.json"),
    collabDir: path.join(bridgeRoot, "collab"),
    eventsFile: path.join(bridgeRoot, "events.jsonl"),
    taskboardFile: path.join(bridgeRoot, "taskboard.json"),
    sessionsFile: path.join(bridgeRoot, "sessions.json"),
    roleRemindersFile: path.join(bridgeRoot, "role-reminders.json"),
    locksDir: path.join(bridgeRoot, "locks"),
    inboxDir: path.join(bridgeRoot, "inbox"),
    outboxDir: path.join(bridgeRoot, "outbox"),
    auditDir: path.join(bridgeRoot, "audit"),
    agentOutputFile: path.join(bridgeRoot, "agent-output.jsonl"),
    promptsDir: path.join(bridgeRoot, "prompts")
  };

  const activeTask = context.activeTaskId
    ? (context.run.tasks.find((item) => item.taskId === context.activeTaskId) ?? null)
    : null;

  return {
    dataRoot: context.dataRoot,
    project,
    paths,
    agentRole: context.agentRole,
    sessionId: context.sessionId,
    activeTaskId: context.activeTaskId,
    activeTaskTitle: activeTask?.resolvedTitle ?? activeTask?.title,
    activeParentTaskId: activeTask?.parentTaskId,
    activeRootTaskId: resolveRootTaskId(context.run, context.activeTaskId),
    activeRequestId: context.activeRequestId,
    parentRequestId: context.parentRequestId
  };
}

export function createWorkflowMiniMaxTeamToolBridge(context: WorkflowMiniMaxTeamToolBridgeContext): TeamToolBridge {
  const lockScope = createWorkflowRunLockScope(context.dataRoot, context.run.runId, context.run.workspacePath);
  const defaults: WorkflowTaskActionDefaults = {
    agentRole: context.agentRole,
    sessionId: context.sessionId,
    activeTaskId: context.activeTaskId,
    parentRequestId: context.parentRequestId
  };

  return {
    async taskAction(requestBody: Record<string, unknown>): Promise<Record<string, unknown>> {
      const mapped = mapWorkflowTaskActionRequest(requestBody, defaults);
      if (!mapped) {
        throw new TeamToolBridgeError(
          400,
          "TASK_ACTION_INVALID",
          "invalid workflow task action payload",
          "Use TASK_CREATE/TASK_REPORT/TASK_DISCUSS_* schema with required fields."
        );
      }
      try {
        return await context.applyTaskAction(mapped);
      } catch (error) {
        if (error instanceof TeamToolBridgeError) {
          throw error;
        }
        const status = asStatus((error as { status?: unknown }).status, 500);
        const code = asCode((error as { code?: unknown }).code, "WORKFLOW_TASK_ACTION_BRIDGE_ERROR");
        const hinted = readString((error as { hint?: unknown }).hint);
        throw new TeamToolBridgeError(
          status,
          code,
          normalizeErrorMessage(error),
          hinted ?? resolveTaskActionNextAction(code),
          (error as { details?: unknown }).details
        );
      }
    },

    async sendMessage(requestBody: Record<string, unknown>): Promise<Record<string, unknown>> {
      const messageType = readString(requestBody.message_type ?? requestBody.messageType);
      if (!messageType || !isManagerChatMessageType(messageType)) {
        throw new TeamToolBridgeError(
          400,
          "MESSAGE_TYPE_INVALID",
          "message_type is invalid",
          "Use discuss tool calls."
        );
      }

      const mapped: WorkflowBridgeSendMessageInput = {
        fromAgent: readString(requestBody.from_agent ?? requestBody.fromAgent) ?? context.agentRole,
        fromSessionId: readString(requestBody.from_session_id ?? requestBody.fromSessionId) ?? context.sessionId,
        messageType,
        toRole: readToRole(requestBody),
        toSessionId: readToSessionId(requestBody),
        taskId: readString(requestBody.task_id ?? requestBody.taskId) ?? context.activeTaskId,
        content: readString(requestBody.content ?? requestBody.message) ?? "",
        requestId: readString(requestBody.request_id ?? requestBody.requestId),
        parentRequestId: readString(requestBody.parent_request_id ?? requestBody.parentRequestId),
        discuss: normalizeOrchestratorDiscussReference(requestBody.discuss) ?? undefined
      };

      try {
        return await context.sendRunMessage(mapped);
      } catch (error) {
        if (error instanceof TeamToolBridgeError) {
          throw error;
        }
        const status = asStatus((error as { status?: unknown }).status, 500);
        const code = asCode((error as { code?: unknown }).code, "WORKFLOW_MESSAGE_BRIDGE_ERROR");
        throw new TeamToolBridgeError(
          status,
          code,
          normalizeErrorMessage(error),
          resolveMessageNextAction(code),
          (error as { details?: unknown }).details
        );
      }
    },

    async getRouteTargets(fromAgent: string): Promise<Record<string, unknown>> {
      const normalizedFrom = fromAgent.trim();
      const sessions = await listWorkflowSessions(context.dataRoot, context.run.runId);
      const roleScope = resolveWorkflowRunRoleScope(context.run, sessions);
      const enabledAgents = roleScope.enabledAgents;
      const enabledSet = roleScope.enabledAgentSet;
      const hasExplicitRouteTable = Boolean(context.run.routeTable && Object.keys(context.run.routeTable).length > 0);
      const explicitTargets = hasExplicitRouteTable ? (context.run.routeTable?.[normalizedFrom] ?? []) : [];
      const allowedTargetIds = hasExplicitRouteTable
        ? uniq(explicitTargets.map((item) => item.trim()).filter((item) => item.length > 0)).filter((item) =>
            enabledSet.has(item)
          )
        : enabledAgents.filter((item) => item !== normalizedFrom);

      const allowedTargets = allowedTargetIds.map((agentId) => ({
        agentId,
        maxDiscussRounds: resolveDiscussRoundLimit(context.run, normalizedFrom, agentId)
      }));

      return {
        runId: context.run.runId,
        fromAgent: normalizedFrom,
        fromAgentEnabled: enabledSet.has(normalizedFrom),
        enabledAgents,
        hasExplicitRouteTable,
        allowedTargets
      };
    },

    async lockAcquire(input: Record<string, unknown>): Promise<Record<string, unknown>> {
      const sessionId = readString(input.session_id ?? input.sessionId) ?? context.sessionId;
      const lockKey = readString(input.lock_key ?? input.lockKey);
      const ttlSeconds = readInteger(input.ttl_seconds ?? input.ttlSeconds) ?? 300;
      const targetTypeRaw = readString(input.target_type ?? input.targetType);
      const targetType = targetTypeRaw === "file" || targetTypeRaw === "dir" ? targetTypeRaw : undefined;
      const purpose = readString(input.purpose);
      if (!lockKey) {
        throw new TeamToolBridgeError(
          400,
          "LOCK_KEY_REQUIRED",
          "lock_key is required",
          "Set lock_key to a workspace-relative path."
        );
      }
      const acquired = await acquireLock(lockScope, {
        sessionId,
        lockKey,
        targetType,
        ttlSeconds,
        purpose
      });
      if (acquired.kind === "acquired") {
        return { result: "acquired", lock: acquired.lock };
      }
      if (acquired.kind === "stolen") {
        return { result: "stolen", lock: acquired.lock, previousLock: acquired.previousLock };
      }
      throw new TeamToolBridgeError(
        409,
        "LOCK_ACQUIRE_FAILED",
        acquired.reason,
        "Wait for lock expiry or choose a different file.",
        acquired.existingLock
      );
    },

    async lockRenew(input: Record<string, unknown>): Promise<Record<string, unknown>> {
      const sessionId = readString(input.session_id ?? input.sessionId) ?? context.sessionId;
      const lockKey = readString(input.lock_key ?? input.lockKey);
      if (!lockKey) {
        throw new TeamToolBridgeError(
          400,
          "LOCK_KEY_REQUIRED",
          "lock_key is required",
          "Set lock_key to renew (workspace-relative path)."
        );
      }
      const renewed = await renewLock(lockScope, { sessionId, lockKey });
      if (renewed.kind === "renewed") {
        return { result: "renewed", lock: renewed.lock };
      }
      if (renewed.kind === "not_found") {
        throw new TeamToolBridgeError(404, "LOCK_NOT_FOUND", "lock not found", "Acquire lock first.");
      }
      if (renewed.kind === "not_owner") {
        throw new TeamToolBridgeError(
          403,
          "LOCK_NOT_OWNER",
          "lock owned by another session",
          "Use owner session or reacquire after expiry.",
          renewed.existingLock
        );
      }
      throw new TeamToolBridgeError(
        409,
        "LOCK_EXPIRED",
        "lock expired",
        "Reacquire lock before editing.",
        renewed.existingLock
      );
    },

    async lockRelease(input: Record<string, unknown>): Promise<Record<string, unknown>> {
      const sessionId = readString(input.session_id ?? input.sessionId) ?? context.sessionId;
      const lockKey = readString(input.lock_key ?? input.lockKey);
      if (!lockKey) {
        throw new TeamToolBridgeError(
          400,
          "LOCK_KEY_REQUIRED",
          "lock_key is required",
          "Set lock_key to release (workspace-relative path)."
        );
      }
      const released = await releaseLock(lockScope, { sessionId, lockKey });
      if (released.kind === "released") {
        return { result: "released", lock: released.lock };
      }
      if (released.kind === "not_found") {
        throw new TeamToolBridgeError(404, "LOCK_NOT_FOUND", "lock not found", "Lock may already be released.");
      }
      throw new TeamToolBridgeError(
        403,
        "LOCK_NOT_OWNER",
        "lock owned by another session",
        "Only lock owner can release.",
        released.existingLock
      );
    },

    async lockList(): Promise<Record<string, unknown>> {
      const items = await listActiveLocks(lockScope);
      return { items, total: items.length };
    }
  };
}
