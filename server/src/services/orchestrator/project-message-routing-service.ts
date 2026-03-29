import { randomUUID } from "node:crypto";
import type { ManagerToAgentMessage, ProjectPaths, ProjectRecord } from "../../domain/models.js";
import {
  getProjectRepositoryBundle,
  type ProjectRepositoryBundle
} from "../../data/repository/project-repository-bundle.js";
import {
  buildManagerMessageRoutedPayload,
  buildMessageRoutedPayload,
  buildUserMessageReceivedPayload
} from "../manager-routing-event-service.js";
import { validateExplicitTargetSession, validateRoleSessionMapWrite } from "../routing-guard-service.js";
import { resolveActiveSessionForRole } from "../session-lifecycle-authority.js";
import { resolveTaskDiscuss } from "./project-dispatch-policy.js";
import {
  appendOrchestratorMessageRouteEventPair,
  buildOrchestratorRoutedManagerMessage,
  createTimestampedIdentifier,
  executeOrchestratorMessageRouting
} from "./shared/index.js";

type ProjectMessageRoutingScope = {
  repositories: ProjectRepositoryBundle;
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  fromAgent: string;
  fromSessionId: string;
  messageType: ProjectRouteMessageType;
  requestId: string;
  parentRequestId: string | null;
  taskId: string | null;
  toRole: string | null;
  sessionId: string;
  messageId: string;
  createdAt: string;
  content: string;
  discuss: unknown | null;
};

type ProjectMessageRoutingContext = {
  repositories: ProjectRepositoryBundle;
  project: ProjectRecord;
  paths: ProjectPaths;
  taskId?: string | null;
};

type ProjectMessageRoutingTarget = {
  role: string | null;
  sessionId: string;
};

type ProjectRouteEventInput = Parameters<ProjectRepositoryBundle["events"]["appendEvent"]>[1];

export type ProjectRouteMessageType =
  | "MANAGER_MESSAGE"
  | "TASK_DISCUSS_REQUEST"
  | "TASK_DISCUSS_REPLY"
  | "TASK_DISCUSS_CLOSED";

export interface ProjectRouteMessageInput {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  fromAgent: string;
  fromSessionId: string;
  messageType: ProjectRouteMessageType;
  toRole: string | null;
  toSessionId: string;
  requestId: string;
  parentRequestId?: string | null;
  taskId?: string | null;
  content: string;
  discuss?: unknown | null;
  messageId?: string;
  createdAt?: string;
}

export interface ProjectRouteMessageResult {
  requestId: string;
  parentRequestId: string | null;
  messageId: string;
  messageType: string;
  taskId: string | null;
  toRole: string | null;
  resolvedSessionId: string;
  mode: "CHAT";
  createdAt: string;
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

export interface ProjectRouteTaskAssignmentResult {
  requestId: string;
  messageId: string;
  messageType: "TASK_ASSIGNMENT";
  taskId: string;
  toRole: string;
  resolvedSessionId: string;
  mode: "CHAT";
  createdAt: string;
}

function getProjectRepositories(dataRoot: string): ProjectRepositoryBundle {
  return getProjectRepositoryBundle(dataRoot);
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

export interface ProjectDeliverMessageInput {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  message: ManagerToAgentMessage;
  targetRole?: string;
  targetSessionId?: string;
  updateRoleSessionMap?: boolean;
}

function buildGeneratedSessionId(role: string): string {
  const safeRole = role.replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `session-${safeRole}-${randomUUID().slice(0, 12)}`;
}

export async function deliverProjectMessage(
  input: ProjectDeliverMessageInput
): Promise<{ sessionExisted: boolean; sessionId: string }> {
  const repositories = getProjectRepositories(input.dataRoot);
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
    targetSessionId = buildGeneratedSessionId(targetRole || "agent");
  }

  const target: ProjectMessageRoutingTarget = {
    role: targetRole || null,
    sessionId: targetSessionId
  };
  const context: ProjectMessageRoutingContext = {
    repositories,
    project: input.project,
    paths: input.paths
  };
  await repositories.runInUnitOfWork({ project: input.project, paths: input.paths }, async () => {
    const role = await resolveRoutingRole(context, target);
    const allTasks = await repositories.taskboard.listTasks(input.paths, input.project.projectId);
    const resolvedMessage = resolveTaskDiscuss(input.message, role, allTasks);
    await repositories.inbox.appendInboxMessage(input.paths, role, resolvedMessage);
    const existingBeforeTouch = await repositories.sessions.getSession(
      input.paths,
      input.project.projectId,
      target.sessionId
    );
    if (existingBeforeTouch) {
      sessionExisted = true;
    }
    await ensureTargetSession(context, target);
    if (input.updateRoleSessionMap ?? true) {
      await syncRoleSessionMap(context, role, target.sessionId);
    }
  });

  return {
    sessionExisted,
    sessionId: target.sessionId
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
  const existing = await scope.repositories.sessions.getSession(scope.paths, scope.project.projectId, target.sessionId);
  const resolvedRole = existing?.role ?? "unknown";
  target.role = resolvedRole;
  return resolvedRole;
}

async function ensureTargetSession(
  scope: ProjectMessageRoutingContext,
  target: ProjectMessageRoutingTarget
): Promise<void> {
  const role = await resolveRoutingRole(scope, target);
  const existing = await scope.repositories.sessions.getSession(scope.paths, scope.project.projectId, target.sessionId);
  if (existing) {
    await scope.repositories.sessions.touchSession(scope.paths, scope.project.projectId, target.sessionId, { role });
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

export async function routeProjectManagerMessage(input: ProjectRouteMessageInput): Promise<ProjectRouteMessageResult> {
  const messageId = input.messageId?.trim() || createTimestampedIdentifier();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const content = input.content.trim();
  const repositories = getProjectRepositories(input.dataRoot);
  const scope: ProjectMessageRoutingScope = {
    repositories,
    dataRoot: input.dataRoot,
    project: input.project,
    paths: input.paths,
    fromAgent: input.fromAgent,
    fromSessionId: input.fromSessionId,
    messageType: input.messageType,
    requestId: input.requestId,
    parentRequestId: input.parentRequestId ?? null,
    taskId: input.taskId ?? null,
    toRole: input.toRole,
    sessionId: input.toSessionId,
    messageId,
    createdAt,
    content,
    discuss: input.discuss ?? null
  };

  return await executeOrchestratorMessageRouting<
    ProjectMessageRoutingScope,
    void,
    ProjectMessageRoutingTarget,
    { messageId: string },
    ProjectRouteMessageResult
  >(scope, undefined, {
    resolveTarget: async (routingScope) => ({
      role: routingScope.toRole,
      sessionId: routingScope.sessionId
    }),
    normalizeEnvelope: async (routingScope) => ({
      messageId: routingScope.messageId
    }),
    persistInbox: async (routingScope, target) => {
      const ownerRole = await resolveRoutingRole(routingScope, target);
      const managerMessage = buildOrchestratorRoutedManagerMessage({
        scopeKind: "project",
        scopeId: routingScope.project.projectId,
        fromAgent: routingScope.fromAgent,
        fromSessionId: routingScope.fromSessionId,
        messageType: routingScope.messageType,
        resolvedRole: ownerRole,
        requestId: routingScope.requestId,
        messageId: routingScope.messageId,
        createdAt: routingScope.createdAt,
        parentRequestId: routingScope.parentRequestId,
        taskId: routingScope.taskId,
        content: routingScope.content,
        discuss: routingScope.discuss
      });
      const allTasks = await routingScope.repositories.taskboard.listTasks(
        routingScope.paths,
        routingScope.project.projectId
      );
      const resolvedMessage = resolveTaskDiscuss(managerMessage, ownerRole, allTasks);
      await routingScope.repositories.inbox.appendInboxMessage(routingScope.paths, ownerRole, resolvedMessage);
    },
    persistRouteEvent: async (routingScope, target, envelope) => {
      await appendOrchestratorMessageRouteEventPair<ProjectRouteEventInput>(
        async (event) => {
          await routingScope.repositories.events.appendEvent(routingScope.paths, event);
        },
        {
          received: {
            projectId: routingScope.project.projectId,
            eventType: "USER_MESSAGE_RECEIVED",
            source: "manager",
            taskId: routingScope.taskId ?? undefined,
            payload: buildUserMessageReceivedPayload({
              requestId: routingScope.requestId,
              parentRequestId: routingScope.parentRequestId,
              content: routingScope.content,
              toRole: target.role,
              fromAgent: routingScope.fromAgent,
              mode: "CHAT",
              messageType: routingScope.messageType,
              taskId: routingScope.taskId,
              discuss: routingScope.discuss
            })
          },
          routed: {
            projectId: routingScope.project.projectId,
            eventType: "MESSAGE_ROUTED",
            source: "manager",
            sessionId: target.sessionId,
            taskId: routingScope.taskId ?? undefined,
            payload: buildMessageRoutedPayload({
              requestId: routingScope.requestId,
              parentRequestId: routingScope.parentRequestId,
              toRole: target.role,
              resolvedSessionId: target.sessionId,
              messageId: envelope.messageId,
              mode: "CHAT",
              messageType: routingScope.messageType,
              taskId: routingScope.taskId,
              discuss: routingScope.discuss,
              content: routingScope.content
            })
          }
        }
      );
    },
    touchSession: async (routingScope, target) => {
      await ensureTargetSession(routingScope, target);
      await syncRoleSessionMap(routingScope, routingScope.toRole, target.sessionId);
    },
    runInUnitOfWork: async (routingScope, _input, operation) => {
      await routingScope.repositories.runInUnitOfWork(
        { project: routingScope.project, paths: routingScope.paths },
        operation
      );
    },
    buildResult: async (routingScope, target, envelope) => ({
      requestId: routingScope.requestId,
      parentRequestId: routingScope.parentRequestId,
      messageId: envelope.messageId,
      messageType: routingScope.messageType,
      taskId: routingScope.taskId,
      toRole: target.role,
      resolvedSessionId: target.sessionId,
      mode: "CHAT",
      createdAt: routingScope.createdAt
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
  const repositories = getProjectRepositories(input.dataRoot);
  const scope: ProjectMessageRoutingScope & { assignmentMessage: ManagerToAgentMessage } = {
    repositories,
    dataRoot: input.dataRoot,
    project: input.project,
    paths: input.paths,
    fromAgent: input.fromAgent,
    fromSessionId: input.fromSessionId,
    messageType: "MANAGER_MESSAGE",
    requestId: input.requestId,
    parentRequestId: null,
    taskId: input.taskId,
    toRole: input.toRole,
    sessionId: input.toSessionId,
    messageId,
    createdAt,
    content: summary,
    discuss: null,
    assignmentMessage: input.message
  };
  return await executeOrchestratorMessageRouting<
    ProjectMessageRoutingScope & { assignmentMessage: ManagerToAgentMessage },
    void,
    ProjectMessageRoutingTarget,
    { messageId: string },
    ProjectRouteTaskAssignmentResult
  >(scope, undefined, {
    resolveTarget: async (routingScope) => ({
      role: routingScope.toRole,
      sessionId: routingScope.sessionId
    }),
    normalizeEnvelope: async (routingScope) => ({
      messageId: routingScope.messageId
    }),
    persistInbox: async (routingScope, target) => {
      const role = await resolveRoutingRole(routingScope, target);
      await routingScope.repositories.inbox.appendInboxMessage(
        routingScope.paths,
        role,
        routingScope.assignmentMessage
      );
    },
    persistRouteEvent: async (routingScope, target, envelope) => {
      await routingScope.repositories.events.appendEvent(routingScope.paths, {
        projectId: routingScope.project.projectId,
        eventType: "MANAGER_MESSAGE_ROUTED",
        source: "manager",
        sessionId: target.sessionId,
        taskId: routingScope.taskId ?? undefined,
        payload: buildManagerMessageRoutedPayload({
          messageId: envelope.messageId,
          toSessionId: target.sessionId,
          toRole: target.role ?? null,
          requestId: routingScope.requestId,
          type: "TASK_ASSIGNMENT",
          mode: "CHAT",
          content: routingScope.content
        })
      });
    },
    touchSession: async (routingScope, target) => {
      await ensureTargetSession(routingScope, target);
      await syncRoleSessionMap(routingScope, target.role, target.sessionId);
    },
    runInUnitOfWork: async (routingScope, _input, operation) => {
      await routingScope.repositories.runInUnitOfWork(
        { project: routingScope.project, paths: routingScope.paths },
        operation
      );
    },
    buildResult: async (routingScope, target, envelope) => ({
      requestId: routingScope.requestId,
      messageId: envelope.messageId,
      messageType: "TASK_ASSIGNMENT",
      taskId: routingScope.taskId ?? "",
      toRole: target.role ?? "",
      resolvedSessionId: target.sessionId,
      mode: "CHAT",
      createdAt: routingScope.createdAt
    })
  });
}
