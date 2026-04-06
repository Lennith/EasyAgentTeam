import type { ManagerToAgentMessage } from "../../../domain/models.js";
import {
  buildOrchestratorRoutedManagerMessage,
  executeOrchestratorMessageRoutingInUnitOfWork,
  resolveOrchestratorMessageEnvelopeMetadata
} from "../shared/index.js";
import {
  appendProjectManagerRouteEvents,
  appendProjectTaskAssignmentRouteEvent,
  buildProjectMessageRouteResult,
  buildProjectMessageRoutingContext,
  buildProjectTaskAssignmentRouteResult,
  ensureTargetSession,
  readRoutingSession,
  resolveDeliverRoutingTarget,
  resolveProjectRouteTarget,
  resolveRoutingRole,
  resolveTaskDiscussMessageForTargetRole,
  runProjectMessageRoutingInUnitOfWork,
  syncRoleSessionMap,
  type ProjectDeliverMessageInput,
  type ProjectMessageRoutingContext,
  type ProjectMessageRoutingTarget,
  type ProjectRouteMessageInput,
  type ProjectRouteMessageResult,
  type ProjectRouteTaskAssignmentInput,
  type ProjectRouteTaskAssignmentResult
} from "./project-message-routing-domain.js";

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
  const envelopeMetadata = resolveOrchestratorMessageEnvelopeMetadata({
    requestId: input.requestId,
    messageId: input.messageId,
    createdAt: input.createdAt
  });
  const { messageId, createdAt } = envelopeMetadata;
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
        requestId: envelopeMetadata.requestId,
        messageId,
        createdAt,
        parentRequestId: input.parentRequestId ?? null,
        taskId: input.taskId ?? null,
        content,
        discuss: input.discuss ?? null
      });
      const resolvedMessage = await resolveTaskDiscussMessageForTargetRole(routingScope, target, managerMessage);
      return {
        messageId,
        resolvedRole: resolvedMessage.resolvedRole,
        resolvedMessage: resolvedMessage.resolvedMessage
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
  const envelopeMetadata = resolveOrchestratorMessageEnvelopeMetadata({
    requestId: input.requestId,
    messageId: input.message.envelope.message_id,
    createdAt: input.message.envelope.timestamp ?? null
  });
  const { messageId, createdAt } = envelopeMetadata;
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
