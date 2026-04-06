import {
  buildWorkflowMessageReceivedPayload,
  buildWorkflowMessageRoutedPayload
} from "../../manager-routing-event-service.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import type {
  ManagerChatMessageType,
  WorkflowManagerToAgentMessage,
  WorkflowRunRecord,
  WorkflowSessionRecord
} from "../../../domain/models.js";
import {
  appendOrchestratorMessageRouteEventPair,
  buildOrchestratorMessageRouteResult,
  buildOrchestratorRoutedManagerMessage,
  type OrchestratorMessageRouteResult,
  type OrchestratorRouteMessageInputBase,
  type OrchestratorDiscussReference,
  resolveOrchestratorMessageEnvelopeMetadata
} from "../shared/index.js";

export { buildWorkflowMessageReceivedPayload, buildWorkflowMessageRoutedPayload };

export type WorkflowRouteMessageType = ManagerChatMessageType;

export interface WorkflowRouteMessageInput extends Omit<OrchestratorRouteMessageInputBase, "discuss" | "messageType"> {
  runId: string;
  messageType: WorkflowRouteMessageType;
  discuss?: OrchestratorDiscussReference;
}

export type WorkflowMessageRouteResult = OrchestratorMessageRouteResult;

export interface WorkflowMessageRoutingContext {
  repositories: WorkflowRepositoryBundle;
  loadRunOrThrow(runId: string): Promise<WorkflowRunRecord>;
  resolveAuthoritativeSession(
    runId: string,
    role: string,
    sessions: WorkflowSessionRecord[],
    runRecord?: WorkflowRunRecord,
    reason?: string
  ): Promise<WorkflowSessionRecord | null>;
  createRuntimeError(
    message: string,
    code: string,
    status?: number,
    hint?: string,
    details?: Record<string, unknown>
  ): Error;
}

export interface WorkflowResolvedMessageTarget {
  session: WorkflowSessionRecord;
  resolvedRole: string;
}

export interface WorkflowMessageEnvelope {
  requestId: string;
  messageId: string;
  createdAt: string;
  message: WorkflowManagerToAgentMessage;
}

type WorkflowRouteEventInput = Parameters<WorkflowRepositoryBundle["events"]["appendEvent"]>[1];

async function resolveWorkflowTargetSession(
  context: WorkflowMessageRoutingContext,
  run: WorkflowRunRecord,
  toRole?: string,
  toSessionId?: string
): Promise<WorkflowSessionRecord | null> {
  if (toSessionId) {
    const session = await context.repositories.sessions.getSession(run.runId, toSessionId);
    if (!session) {
      throw context.createRuntimeError(`session '${toSessionId}' not found`, "TASK_NOT_FOUND", 404);
    }
    return session;
  }
  if (!toRole) {
    return null;
  }
  const sessions = await context.repositories.sessions.listSessions(run.runId);
  return await context.resolveAuthoritativeSession(run.runId, toRole, sessions, run, "message_route");
}

export async function resolveWorkflowRouteTarget(input: {
  context: WorkflowMessageRoutingContext;
  run: WorkflowRunRecord;
  toRole?: string;
  toSessionId?: string;
}): Promise<WorkflowResolvedMessageTarget> {
  const session = await resolveWorkflowTargetSession(input.context, input.run, input.toRole, input.toSessionId);
  if (!session) {
    throw input.context.createRuntimeError("target session cannot be resolved", "MESSAGE_TARGET_REQUIRED", 404);
  }
  return {
    session,
    resolvedRole: input.toRole ?? session.role
  };
}

export function buildWorkflowRouteEnvelope(input: {
  run: WorkflowRunRecord;
  fromAgent: string;
  routeInput: WorkflowRouteMessageInput;
  target: WorkflowResolvedMessageTarget;
}): WorkflowMessageEnvelope {
  const { requestId, messageId, createdAt } = resolveOrchestratorMessageEnvelopeMetadata({
    requestId: input.routeInput.requestId
  });
  return {
    requestId,
    messageId,
    createdAt,
    message: buildWorkflowRoutedMessage({
      runId: input.run.runId,
      fromAgent: input.fromAgent,
      fromSessionId: input.routeInput.fromSessionId,
      messageType: input.routeInput.messageType,
      resolvedRole: input.target.resolvedRole,
      requestId,
      messageId,
      createdAt,
      taskId: input.routeInput.taskId,
      content: input.routeInput.content,
      parentRequestId: input.routeInput.parentRequestId,
      discuss: input.routeInput.discuss
    })
  };
}

export async function appendWorkflowRouteEvents(input: {
  context: WorkflowMessageRoutingContext;
  routeInput: WorkflowRouteMessageInput;
  fromAgent: string;
  target: WorkflowResolvedMessageTarget;
  envelope: WorkflowMessageEnvelope;
}): Promise<void> {
  const receivedSource: "manager" | "agent" = input.fromAgent === "manager" ? "manager" : "agent";
  await appendOrchestratorMessageRouteEventPair<WorkflowRouteEventInput>(
    async (event) => {
      await input.context.repositories.events.appendEvent(input.routeInput.runId, event);
    },
    {
      received: {
        eventType: "USER_MESSAGE_RECEIVED",
        source: receivedSource,
        sessionId: input.routeInput.fromSessionId,
        taskId: input.routeInput.taskId,
        payload: buildWorkflowMessageReceivedPayload({
          fromAgent: input.fromAgent,
          toRole: input.target.resolvedRole,
          requestId: input.envelope.requestId,
          content: input.routeInput.content
        })
      },
      routed: {
        eventType: "MESSAGE_ROUTED",
        source: "manager",
        sessionId: input.target.session.sessionId,
        taskId: input.routeInput.taskId,
        payload: buildWorkflowMessageRoutedPayload({
          fromAgent: input.fromAgent,
          toRole: input.target.resolvedRole,
          resolvedSessionId: input.target.session.sessionId,
          requestId: input.envelope.requestId,
          messageId: input.envelope.messageId,
          content: input.routeInput.content,
          messageType: input.routeInput.messageType,
          discuss: input.routeInput.discuss ?? null
        })
      }
    }
  );
}

export function buildWorkflowMessageRouteResult(input: {
  routeInput: WorkflowRouteMessageInput;
  target: WorkflowResolvedMessageTarget;
  envelope: WorkflowMessageEnvelope;
}): WorkflowMessageRouteResult {
  return buildOrchestratorMessageRouteResult({
    requestId: input.envelope.requestId,
    messageId: input.envelope.messageId,
    messageType: input.routeInput.messageType,
    taskId: input.routeInput.taskId ?? null,
    toRole: input.target.resolvedRole,
    resolvedSessionId: input.target.session.sessionId,
    createdAt: input.envelope.createdAt
  });
}

export function buildWorkflowRoutedMessage(input: {
  runId: string;
  fromAgent: string;
  fromSessionId: string;
  messageType: WorkflowRouteMessageInput["messageType"];
  resolvedRole: string;
  requestId: string;
  messageId: string;
  createdAt: string;
  taskId?: string;
  content: string;
  parentRequestId?: string;
  discuss?: OrchestratorDiscussReference;
}): WorkflowManagerToAgentMessage {
  return buildOrchestratorRoutedManagerMessage({
    scopeKind: "workflow",
    scopeId: input.runId,
    fromAgent: input.fromAgent,
    fromSessionId: input.fromSessionId,
    messageType: input.messageType,
    resolvedRole: input.resolvedRole,
    requestId: input.requestId,
    messageId: input.messageId,
    createdAt: input.createdAt,
    parentRequestId: input.parentRequestId,
    taskId: input.taskId,
    content: input.content,
    discuss: input.discuss ?? null
  });
}
