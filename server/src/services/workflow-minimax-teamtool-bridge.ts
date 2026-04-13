import path from "node:path";
import { listWorkflowSessions } from "../data/repository/workflow/runtime-repository.js";
import { createWorkflowRunLockScope } from "../data/repository/project/lock-repository.js";
import { isManagerChatMessageType } from "../domain/models.js";
import type {
  ProjectPaths,
  ProjectRecord,
  WorkflowRunRecord,
  WorkflowTaskActionRequest,
  WorkflowTaskActionType,
  WorkflowTaskOutcome
} from "../domain/models.js";
import type { TeamToolBridge, TeamToolExecutionContext } from "./teamtool/types.js";
import { normalizeOrchestratorDiscussReference } from "./orchestrator/shared/index.js";
import type { WorkflowRouteMessageInput } from "./orchestrator/workflow/workflow-message-routing-service.js";
import { resolveDiscussRoundLimit } from "./discuss-policy-service.js";
import {
  asCode,
  asStatus,
  createMiniMaxTeamToolBridgeBase,
  normalizeErrorMessage,
  readRecord,
  readString,
  readStringList,
  TeamToolBridgeError
} from "./minimax-teamtool-bridge-core.js";
import {
  buildRouteTargetsGuidance,
  buildTaskExistsNextAction,
  formatTeamToolNameWithCodexAlias
} from "./teamtool-contract.js";
import { resolveWorkflowRunRoleScope } from "./workflow-role-scope-service.js";

export { TeamToolBridgeError } from "./minimax-teamtool-bridge-core.js";

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
    case "TASK_EXISTS":
      return buildTaskExistsNextAction();
    case "TASK_NOT_FOUND":
      return "Re-check task_id/parent_task_id/to_role and retry.";
    case "TASK_OWNER_ROLE_NOT_FOUND":
      return buildRouteTargetsGuidance("choose an allowed target role, and retry TASK_CREATE.");
    case "TASK_DEPENDENCY_NOT_READY":
      return "Wait for dependency tasks listed in error.details.dependency_task_ids to reach DONE/CANCELED, then retry.";
    case "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN":
      return "Remove parent/ancestor task ids from dependencies and retry TASK_CREATE.";
    case "RUN_NOT_RUNNING":
      return "Run is not active. Restart run before sending task actions.";
    case "ROUTE_DENIED":
      return `Choose an allowed target from ${formatTeamToolNameWithCodexAlias("route_targets_get")} before discussing.`;
    default:
      return null;
  }
}

function resolveMessageNextAction(code: string): string | null {
  switch (code) {
    case "MESSAGE_TARGET_REQUIRED":
      return "Provide to_role or to_session_id.";
    case "ROUTE_DENIED":
      return `Choose an allowed target from ${formatTeamToolNameWithCodexAlias("route_targets_get")}.`;
    case "TASK_NOT_FOUND":
      return "Re-check task_id and discussion thread binding.";
    default:
      return null;
  }
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

  return createMiniMaxTeamToolBridgeBase({
    lockScope,
    defaultSessionId: context.sessionId,
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
        const nextAction = readString((error as { nextAction?: unknown }).nextAction);
        throw new TeamToolBridgeError(
          status,
          code,
          normalizeErrorMessage(error),
          nextAction ?? resolveTaskActionNextAction(code),
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
    }
  });
}
