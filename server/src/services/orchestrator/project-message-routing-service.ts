import type {
  ManagerChatMessageType,
  ManagerToAgentMessage,
  ProjectPaths,
  ProjectRecord,
  SessionRecord,
  TaskRecord
} from "../../domain/models.js";
import {
  buildManagerMessageRoutedPayload,
  buildMessageRoutedPayload,
  buildUserMessageReceivedPayload
} from "../manager-routing-event-service.js";
import {
  getProjectRepositoryBundle,
  type ProjectRepositoryBundle
} from "../../data/repository/project-repository-bundle.js";
import { validateExplicitTargetSession, validateRoleSessionMapWrite } from "../routing-guard-service.js";
import { resolveActiveSessionForRole } from "../session-lifecycle-authority.js";
import { resolveTaskDiscuss } from "./project-dispatch-policy.js";
import {
  appendOrchestratorMessageRouteEventPair,
  buildOrchestratorMessageRouteResult,
  buildOrchestratorRoutedManagerMessage,
  buildRoleScopedSessionId,
  createOrchestratorMessageRoutingUnitOfWorkRunner,
  createTimestampedIdentifier,
  executeOrchestratorMessageRoutingInUnitOfWork
} from "./shared/index.js";
import type {
  OrchestratorDiscussReference,
  OrchestratorMessageRouteResult,
  OrchestratorRouteMessageInputBase
} from "./shared/index.js";

export type ProjectMessageRoutingContext = {
  repositories: ProjectRepositoryBundle;
  project: ProjectRecord;
  paths: ProjectPaths;
  taskId?: string | null;
  sessionCache: Map<string, SessionRecord | null>;
  allTasksCache?: TaskRecord[];
};

export type ProjectMessageRoutingTarget = {
  role: string | null;
  sessionId: string;
};

export type ProjectRouteEventInput = Parameters<ProjectRepositoryBundle["events"]["appendEvent"]>[1];

export type ProjectRouteTargetInput = {
  toRole?: string | null;
  toSessionId: string;
};

export type ProjectRouteMessageType = ManagerChatMessageType;

export interface ProjectRouteMessageInput extends Omit<
  OrchestratorRouteMessageInputBase,
  "messageType" | "toRole" | "toSessionId" | "taskId" | "requestId" | "parentRequestId" | "discuss"
> {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  messageType: ProjectRouteMessageType;
  toRole: string | null;
  toSessionId: string;
  requestId: string;
  parentRequestId?: string | null;
  taskId?: string | null;
  discuss?: OrchestratorDiscussReference | null;
  messageId?: string;
  createdAt?: string;
}

export interface ProjectRouteMessageResult extends OrchestratorMessageRouteResult {
  parentRequestId: string | null;
  mode: "CHAT";
}

export interface ProjectRouteTaskAssignmentInput {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  fromAgent: string;
  fromSessionId: string;
  requestId: string;
  taskId: string;
  toRole: string;
  toSessionId: string;
  message: ManagerToAgentMessage;
}

export interface ProjectRouteTaskAssignmentResult extends OrchestratorMessageRouteResult {
  messageType: "TASK_ASSIGNMENT";
  taskId: string;
  toRole: string;
  mode: "CHAT";
}

export interface ProjectDeliverMessageInput {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  message: ManagerToAgentMessage;
  targetRole?: string;
  targetSessionId?: string;
  updateRoleSessionMap?: boolean;
}

export class ProjectMessageRoutingError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "invalid_target_session_reserved"
      | "target_session_not_found"
      | "target_session_role_mismatch",
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

function getProjectRepositories(dataRoot: string): ProjectRepositoryBundle {
  return getProjectRepositoryBundle(dataRoot);
}

function buildProjectMessageRoutingContext(input: {
  dataRoot: string;
  project: ProjectDeliverMessageInput["project"];
  paths: ProjectDeliverMessageInput["paths"];
  taskId?: string | null;
}): ProjectMessageRoutingContext {
  return {
    repositories: getProjectRepositories(input.dataRoot),
    project: input.project,
    paths: input.paths,
    taskId: input.taskId,
    sessionCache: new Map()
  };
}

function resolveProjectRouteTarget(
  _scope: ProjectMessageRoutingContext,
  input: ProjectRouteTargetInput
): ProjectMessageRoutingTarget {
  return {
    role: input.toRole?.trim() || null,
    sessionId: input.toSessionId.trim()
  };
}

async function readRoutingSession(
  scope: ProjectMessageRoutingContext,
  sessionId: string
): Promise<SessionRecord | null> {
  const normalizedSessionId = sessionId.trim();
  if (scope.sessionCache.has(normalizedSessionId)) {
    return scope.sessionCache.get(normalizedSessionId) ?? null;
  }
  const session = await scope.repositories.sessions.getSession(
    scope.paths,
    scope.project.projectId,
    normalizedSessionId
  );
  scope.sessionCache.set(normalizedSessionId, session ?? null);
  return session ?? null;
}

function invalidateRoutingSession(scope: ProjectMessageRoutingContext, sessionId: string): void {
  scope.sessionCache.delete(sessionId.trim());
}

async function listRoutingTasks(scope: ProjectMessageRoutingContext): Promise<TaskRecord[]> {
  if (scope.allTasksCache) {
    return scope.allTasksCache;
  }
  const allTasks = await scope.repositories.taskboard.listTasks(scope.paths, scope.project.projectId);
  scope.allTasksCache = allTasks;
  return allTasks;
}

async function resolveDeliverRoutingTarget(input: ProjectDeliverMessageInput): Promise<{
  target: ProjectMessageRoutingTarget;
  sessionExisted: boolean;
}> {
  const roleFromEnvelope = input.message.envelope.accountability?.owner_role;
  let targetRole = (input.targetRole ?? roleFromEnvelope ?? "").trim();
  let targetSessionId = input.targetSessionId?.trim();
  let sessionExisted = false;

  if (targetSessionId) {
    const validated = await validateExplicitTargetSession(
      input.paths,
      input.project.projectId,
      targetSessionId,
      targetRole || undefined
    );
    if (!validated.ok) {
      throw new ProjectMessageRoutingError(validated.error.message, validated.error.code, validated.error.details);
    }
    targetSessionId = validated.sessionId;
    if (!targetRole) {
      targetRole = validated.resolvedRole;
    }
    sessionExisted = true;
  }

  if (!targetSessionId && targetRole) {
    const active = await resolveActiveSessionForRole({
      dataRoot: input.dataRoot,
      project: input.project,
      paths: input.paths,
      role: targetRole,
      reason: "manager_deliver_message"
    });
    if (active) {
      targetSessionId = active.sessionId;
      sessionExisted = true;
    }
  }

  if (!targetSessionId) {
    targetSessionId = buildRoleScopedSessionId(targetRole || "agent");
  }

  return {
    target: {
      role: targetRole || null,
      sessionId: targetSessionId
    },
    sessionExisted
  };
}

async function resolveRoutingRole(
  scope: ProjectMessageRoutingContext,
  target: ProjectMessageRoutingTarget
): Promise<string> {
  const explicitRole = target.role?.trim();
  if (explicitRole) {
    target.role = explicitRole;
    return explicitRole;
  }
  const existing = await readRoutingSession(scope, target.sessionId);
  const resolvedRole = existing?.role ?? "unknown";
  target.role = resolvedRole;
  return resolvedRole;
}

async function resolveTaskDiscussMessageForTargetRole(
  scope: ProjectMessageRoutingContext,
  target: ProjectMessageRoutingTarget,
  message: ManagerToAgentMessage
): Promise<{
  resolvedRole: string;
  resolvedMessage: ManagerToAgentMessage;
}> {
  const resolvedRole = await resolveRoutingRole(scope, target);
  const resolvedMessage = await resolveTaskDiscussMessage(scope, resolvedRole, message);
  return {
    resolvedRole,
    resolvedMessage
  };
}

async function resolveTaskDiscussMessage(
  scope: ProjectMessageRoutingContext,
  resolvedRole: string,
  message: ManagerToAgentMessage
): Promise<ManagerToAgentMessage> {
  const allTasks = await listRoutingTasks(scope);
  return resolveTaskDiscuss(message, resolvedRole, allTasks);
}

async function ensureTargetSession(
  scope: ProjectMessageRoutingContext,
  target: ProjectMessageRoutingTarget
): Promise<void> {
  const role = await resolveRoutingRole(scope, target);
  const existing = await readRoutingSession(scope, target.sessionId);
  if (existing) {
    await scope.repositories.sessions.touchSession(scope.paths, scope.project.projectId, target.sessionId, { role });
    invalidateRoutingSession(scope, target.sessionId);
    return;
  }
  const roleProviderId = scope.project.agentModelConfigs?.[role]?.provider_id ?? "minimax";
  await scope.repositories.sessions.addSession(scope.paths, scope.project.projectId, {
    sessionId: target.sessionId,
    role,
    status: "idle",
    providerSessionId: undefined,
    provider: roleProviderId
  });
  invalidateRoutingSession(scope, target.sessionId);
}

async function syncRoleSessionMap(
  scope: ProjectMessageRoutingContext,
  role: string | null,
  sessionId: string
): Promise<void> {
  if (!role) {
    return;
  }
  const mapWriteError = validateRoleSessionMapWrite(role, sessionId);
  if (mapWriteError) {
    await scope.repositories.events.appendEvent(scope.paths, {
      projectId: scope.project.projectId,
      eventType: "ROLE_SESSION_MAPPING_REJECTED",
      source: "manager",
      sessionId,
      taskId: scope.taskId ?? undefined,
      payload: {
        role,
        targetSessionId: sessionId,
        reason: mapWriteError.message,
        errorCode: mapWriteError.code
      }
    });
    return;
  }
  await scope.repositories.projectRuntime.setRoleSessionMapping(scope.project.projectId, role, sessionId);
}

async function appendProjectManagerRouteEvents(
  scope: ProjectMessageRoutingContext,
  input: ProjectRouteMessageInput,
  target: ProjectMessageRoutingTarget,
  messageId: string
): Promise<void> {
  const parentRequestId = input.parentRequestId ?? null;
  const taskId = input.taskId ?? null;
  const content = input.content.trim();
  const discuss = input.discuss ?? null;
  await appendOrchestratorMessageRouteEventPair<ProjectRouteEventInput>(
    async (event) => {
      await scope.repositories.events.appendEvent(scope.paths, event);
    },
    {
      received: {
        projectId: scope.project.projectId,
        eventType: "USER_MESSAGE_RECEIVED",
        source: "manager",
        taskId: scope.taskId ?? undefined,
        payload: buildUserMessageReceivedPayload({
          requestId: input.requestId,
          parentRequestId,
          content,
          toRole: target.role,
          fromAgent: input.fromAgent,
          mode: "CHAT",
          messageType: input.messageType,
          taskId,
          discuss
        })
      },
      routed: {
        projectId: scope.project.projectId,
        eventType: "MESSAGE_ROUTED",
        source: "manager",
        sessionId: target.sessionId,
        taskId: taskId ?? undefined,
        payload: buildMessageRoutedPayload({
          requestId: input.requestId,
          parentRequestId,
          toRole: target.role,
          resolvedSessionId: target.sessionId,
          messageId,
          mode: "CHAT",
          messageType: input.messageType,
          taskId,
          discuss,
          content
        })
      }
    }
  );
}

async function appendProjectTaskAssignmentRouteEvent(
  scope: ProjectMessageRoutingContext,
  input: ProjectRouteTaskAssignmentInput,
  target: ProjectMessageRoutingTarget,
  messageId: string,
  summary: string
): Promise<void> {
  await scope.repositories.events.appendEvent(scope.paths, {
    projectId: scope.project.projectId,
    eventType: "MANAGER_MESSAGE_ROUTED",
    source: "manager",
    sessionId: target.sessionId,
    taskId: input.taskId,
    payload: buildManagerMessageRoutedPayload({
      messageId,
      toSessionId: target.sessionId,
      toRole: target.role ?? null,
      requestId: input.requestId,
      type: "TASK_ASSIGNMENT",
      mode: "CHAT",
      content: summary
    })
  });
}

function buildProjectMessageRouteResult(input: {
  routeInput: ProjectRouteMessageInput;
  target: ProjectMessageRoutingTarget;
  messageId: string;
  createdAt: string;
}): ProjectRouteMessageResult {
  return buildOrchestratorMessageRouteResult({
    requestId: input.routeInput.requestId,
    parentRequestId: input.routeInput.parentRequestId ?? null,
    messageId: input.messageId,
    messageType: input.routeInput.messageType,
    taskId: input.routeInput.taskId ?? null,
    toRole: input.target.role,
    resolvedSessionId: input.target.sessionId,
    mode: "CHAT" as const,
    createdAt: input.createdAt
  });
}

function buildProjectTaskAssignmentRouteResult(input: {
  routeInput: ProjectRouteTaskAssignmentInput;
  target: ProjectMessageRoutingTarget;
  messageId: string;
  createdAt: string;
}): ProjectRouteTaskAssignmentResult {
  return buildOrchestratorMessageRouteResult({
    requestId: input.routeInput.requestId,
    messageId: input.messageId,
    messageType: "TASK_ASSIGNMENT" as const,
    taskId: input.routeInput.taskId,
    toRole: input.target.role ?? "",
    resolvedSessionId: input.target.sessionId,
    mode: "CHAT" as const,
    createdAt: input.createdAt
  });
}

const runProjectMessageRoutingInUnitOfWork = createOrchestratorMessageRoutingUnitOfWorkRunner<
  ProjectMessageRoutingContext,
  unknown
>(async (scope, operation) => {
  await scope.repositories.runInUnitOfWork({ project: scope.project, paths: scope.paths }, operation);
});

export async function deliverProjectMessage(
  input: ProjectDeliverMessageInput
): Promise<{ sessionExisted: boolean; sessionId: string }> {
  const scope = buildProjectMessageRoutingContext({
    dataRoot: input.dataRoot,
    project: input.project,
    paths: input.paths
  });
  const resolvedTarget = await resolveDeliverRoutingTarget(input);
  const target = resolvedTarget.target;
  let sessionExisted = resolvedTarget.sessionExisted;

  return await executeOrchestratorMessageRoutingInUnitOfWork<
    ProjectMessageRoutingContext,
    ProjectDeliverMessageInput,
    ProjectMessageRoutingTarget,
    { resolvedRole: string; resolvedMessage: ManagerToAgentMessage },
    { sessionExisted: boolean; sessionId: string }
  >(scope, input, runProjectMessageRoutingInUnitOfWork, {
    resolveTarget: async () => target,
    normalizeEnvelope: async (routingScope, routingTarget) =>
      await resolveTaskDiscussMessageForTargetRole(routingScope, routingTarget, input.message),
    persistInbox: async (routingScope, _routingTarget, envelope) => {
      await routingScope.repositories.inbox.appendInboxMessage(
        routingScope.paths,
        envelope.resolvedRole,
        envelope.resolvedMessage
      );
    },
    persistRouteEvent: async () => {},
    touchSession: async (routingScope, routingTarget) => {
      const existingBeforeTouch = await readRoutingSession(routingScope, routingTarget.sessionId);
      if (existingBeforeTouch) {
        sessionExisted = true;
      }
      await ensureTargetSession(routingScope, routingTarget);
      if (input.updateRoleSessionMap ?? true) {
        await syncRoleSessionMap(routingScope, routingTarget.role, routingTarget.sessionId);
      }
    },
    buildResult: async (_routingScope, routingTarget) => ({
      sessionExisted,
      sessionId: routingTarget.sessionId
    })
  });
}

export async function routeProjectManagerMessage(input: ProjectRouteMessageInput): Promise<ProjectRouteMessageResult> {
  const messageId = input.messageId?.trim() || createTimestampedIdentifier();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const content = input.content.trim();
  const scope = buildProjectMessageRoutingContext({
    dataRoot: input.dataRoot,
    project: input.project,
    paths: input.paths,
    taskId: input.taskId ?? null
  });

  return await executeOrchestratorMessageRoutingInUnitOfWork<
    ProjectMessageRoutingContext,
    ProjectRouteMessageInput,
    ProjectMessageRoutingTarget,
    { messageId: string; resolvedRole: string; resolvedMessage: ManagerToAgentMessage },
    ProjectRouteMessageResult
  >(scope, input, runProjectMessageRoutingInUnitOfWork, {
    resolveTarget: async (routingScope, routeInput) => resolveProjectRouteTarget(routingScope, routeInput),
    normalizeEnvelope: async (routingScope, target) => {
      const resolvedRole = await resolveRoutingRole(routingScope, target);
      const managerMessage = buildOrchestratorRoutedManagerMessage({
        scopeKind: "project",
        scopeId: input.project.projectId,
        fromAgent: input.fromAgent,
        fromSessionId: input.fromSessionId,
        messageType: input.messageType,
        resolvedRole,
        requestId: input.requestId,
        messageId,
        createdAt,
        parentRequestId: input.parentRequestId ?? null,
        taskId: input.taskId ?? null,
        content,
        discuss: input.discuss ?? null
      });
      const resolvedMessage = await resolveTaskDiscussMessage(routingScope, resolvedRole, managerMessage);
      return {
        messageId,
        resolvedRole,
        resolvedMessage
      };
    },
    persistInbox: async (routingScope, _target, envelope) => {
      await routingScope.repositories.inbox.appendInboxMessage(
        routingScope.paths,
        envelope.resolvedRole,
        envelope.resolvedMessage
      );
    },
    persistRouteEvent: async (routingScope, target, envelope) =>
      await appendProjectManagerRouteEvents(routingScope, input, target, envelope.messageId),
    touchSession: async (routingScope, target) => {
      await ensureTargetSession(routingScope, target);
      await syncRoleSessionMap(routingScope, input.toRole ?? null, target.sessionId);
    },
    buildResult: async (_routingScope, target, envelope) =>
      buildProjectMessageRouteResult({
        routeInput: input,
        target,
        messageId: envelope.messageId,
        createdAt
      })
  });
}

export async function routeProjectTaskAssignmentMessage(
  input: ProjectRouteTaskAssignmentInput
): Promise<ProjectRouteTaskAssignmentResult> {
  const messageId = input.message.envelope.message_id;
  const createdAt = input.message.envelope.timestamp ?? new Date().toISOString();
  const summaryValue = input.message.body["summary"];
  const summary = typeof summaryValue === "string" ? summaryValue : "";
  const scope = buildProjectMessageRoutingContext({
    dataRoot: input.dataRoot,
    project: input.project,
    paths: input.paths,
    taskId: input.taskId
  });

  return await executeOrchestratorMessageRoutingInUnitOfWork<
    ProjectMessageRoutingContext,
    ProjectRouteTaskAssignmentInput,
    ProjectMessageRoutingTarget,
    {
      messageId: string;
      resolvedRole: string;
      assignmentMessage: ManagerToAgentMessage;
      summary: string;
      createdAt: string;
    },
    ProjectRouteTaskAssignmentResult
  >(scope, input, runProjectMessageRoutingInUnitOfWork, {
    resolveTarget: async (routingScope, routeInput) => resolveProjectRouteTarget(routingScope, routeInput),
    normalizeEnvelope: async (_routingScope, target) => ({
      messageId,
      resolvedRole: target.role ?? input.toRole,
      assignmentMessage: input.message,
      summary,
      createdAt
    }),
    persistInbox: async (routingScope, _target, envelope) => {
      await routingScope.repositories.inbox.appendInboxMessage(
        routingScope.paths,
        envelope.resolvedRole,
        envelope.assignmentMessage
      );
    },
    persistRouteEvent: async (routingScope, target, envelope) =>
      await appendProjectTaskAssignmentRouteEvent(routingScope, input, target, envelope.messageId, envelope.summary),
    touchSession: async (routingScope, target) => {
      await ensureTargetSession(routingScope, target);
      await syncRoleSessionMap(routingScope, target.role, target.sessionId);
    },
    buildResult: async (_routingScope, target, envelope) =>
      buildProjectTaskAssignmentRouteResult({
        routeInput: input,
        target,
        messageId: envelope.messageId,
        createdAt: envelope.createdAt
      })
  });
}
