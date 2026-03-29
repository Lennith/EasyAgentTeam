import type { WorkflowRepositoryBundle } from "../../data/repository/workflow-repository-bundle.js";
import type { WorkflowManagerToAgentMessage, WorkflowRunRecord, WorkflowSessionRecord } from "../../domain/models.js";
import {
  buildWorkflowMessageReceivedPayload,
  buildWorkflowMessageRoutedPayload
} from "../manager-routing-event-service.js";
import { hasWorkflowRoutePermission } from "./workflow-dispatch-policy.js";
import { createTimestampRequestId, createTimestampedIdentifier } from "./shared/orchestrator-identifiers.js";
import {
  appendOrchestratorMessageRouteEventPair,
  buildOrchestratorRoutedManagerMessage,
  executeOrchestratorMessageRouting
} from "./shared/index.js";

type WorkflowRouteMessageType =
  | "MANAGER_MESSAGE"
  | "TASK_DISCUSS_REQUEST"
  | "TASK_DISCUSS_REPLY"
  | "TASK_DISCUSS_CLOSED";

export interface WorkflowRouteMessageInput {
  runId: string;
  fromAgent: string;
  fromSessionId: string;
  messageType: WorkflowRouteMessageType;
  toRole?: string;
  toSessionId?: string;
  taskId?: string;
  content: string;
  requestId?: string;
  parentRequestId?: string;
  discuss?: { threadId?: string; requestId?: string };
}

export interface WorkflowMessageRouteResult {
  requestId: string;
  messageId: string;
  messageType: string;
  taskId: string | null;
  toRole: string | null;
  resolvedSessionId: string;
  createdAt: string;
}

export { buildWorkflowMessageReceivedPayload, buildWorkflowMessageRoutedPayload };

interface WorkflowMessageRoutingContext {
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

interface WorkflowResolvedMessageTarget {
  session: WorkflowSessionRecord;
  resolvedRole: string;
}

interface WorkflowMessageEnvelope {
  requestId: string;
  messageId: string;
  createdAt: string;
  message: WorkflowManagerToAgentMessage;
}

type WorkflowRouteEventInput = Parameters<WorkflowRepositoryBundle["events"]["appendEvent"]>[1];

export class WorkflowMessageRoutingService {
  constructor(private readonly context: WorkflowMessageRoutingContext) {}

  async routeMessage(input: WorkflowRouteMessageInput): Promise<WorkflowMessageRouteResult> {
    const run = await this.context.loadRunOrThrow(input.runId);
    const fromAgent = input.fromAgent.trim() || "manager";
    const toRole = input.toRole?.trim();
    const toSessionId = input.toSessionId?.trim();
    if (!toRole && !toSessionId) {
      throw this.context.createRuntimeError(
        "to.agent (role) or to.session_id is required",
        "MESSAGE_TARGET_REQUIRED",
        400
      );
    }
    if (toRole && !hasWorkflowRoutePermission(run, fromAgent, toRole)) {
      throw this.context.createRuntimeError("route not allowed by workflow route table", "ROUTE_DENIED", 403);
    }
    return await executeOrchestratorMessageRouting<
      WorkflowRunRecord,
      WorkflowRouteMessageInput,
      WorkflowResolvedMessageTarget,
      WorkflowMessageEnvelope,
      WorkflowMessageRouteResult
    >(run, input, {
      resolveTarget: async (scopeRun, _messageInput) => {
        const session = await this.resolveTargetSession(scopeRun, toRole, toSessionId);
        if (!session) {
          throw this.context.createRuntimeError("target session cannot be resolved", "MESSAGE_TARGET_REQUIRED", 404);
        }
        return {
          session,
          resolvedRole: toRole ?? session.role
        };
      },
      normalizeEnvelope: async (scopeRun, target, _messageInput) => {
        const requestId = input.requestId?.trim() || createTimestampRequestId();
        const messageId = createTimestampedIdentifier();
        const createdAt = new Date().toISOString();
        return {
          requestId,
          messageId,
          createdAt,
          message: buildWorkflowRoutedMessage({
            runId: scopeRun.runId,
            fromAgent,
            fromSessionId: input.fromSessionId,
            messageType: input.messageType,
            resolvedRole: target.resolvedRole,
            requestId,
            messageId,
            createdAt,
            taskId: input.taskId,
            content: input.content,
            parentRequestId: input.parentRequestId,
            discuss: input.discuss
          })
        };
      },
      runInUnitOfWork: async (scopeRun, _messageInput, operation) => {
        await this.context.repositories.runInUnitOfWork({ run: scopeRun }, operation);
      },
      persistInbox: async (_scopeRun, target, envelope, _messageInput) => {
        await this.context.repositories.inbox.appendInboxMessage(input.runId, target.resolvedRole, envelope.message);
      },
      persistRouteEvent: async (_scopeRun, target, envelope, _messageInput) => {
        await appendOrchestratorMessageRouteEventPair<WorkflowRouteEventInput>(
          async (event) => {
            await this.context.repositories.events.appendEvent(input.runId, event);
          },
          {
            received: {
              eventType: "USER_MESSAGE_RECEIVED",
              source: fromAgent === "manager" ? "manager" : "agent",
              sessionId: input.fromSessionId,
              taskId: input.taskId,
              payload: buildWorkflowMessageReceivedPayload({
                fromAgent,
                toRole: target.resolvedRole,
                requestId: envelope.requestId,
                content: input.content
              })
            },
            routed: {
              eventType: "MESSAGE_ROUTED",
              source: "manager",
              sessionId: target.session.sessionId,
              taskId: input.taskId,
              payload: buildWorkflowMessageRoutedPayload({
                fromAgent,
                toRole: target.resolvedRole,
                resolvedSessionId: target.session.sessionId,
                requestId: envelope.requestId,
                messageId: envelope.messageId,
                content: input.content,
                messageType: input.messageType,
                discuss: input.discuss ?? null
              })
            }
          }
        );
      },
      touchSession: async (_scopeRun, target, envelope, _messageInput) => {
        await this.context.repositories.sessions.touchSession(input.runId, target.session.sessionId, {
          lastInboxMessageId: envelope.messageId
        });
      },
      buildResult: async (_scopeRun, target, envelope, _messageInput) => ({
        requestId: envelope.requestId,
        messageId: envelope.messageId,
        messageType: input.messageType,
        taskId: input.taskId ?? null,
        toRole: target.resolvedRole,
        resolvedSessionId: target.session.sessionId,
        createdAt: envelope.createdAt
      })
    });
  }

  private async resolveTargetSession(
    run: WorkflowRunRecord,
    toRole?: string,
    toSessionId?: string
  ): Promise<WorkflowSessionRecord | null> {
    if (toSessionId) {
      const session = await this.context.repositories.sessions.getSession(run.runId, toSessionId);
      if (!session) {
        throw this.context.createRuntimeError(`session '${toSessionId}' not found`, "TASK_NOT_FOUND", 404);
      }
      return session;
    }
    if (!toRole) {
      return null;
    }
    const sessions = await this.context.repositories.sessions.listSessions(run.runId);
    return await this.context.resolveAuthoritativeSession(run.runId, toRole, sessions, run, "message_route");
  }
}

export function buildWorkflowRoutedMessage(input: {
  runId: string;
  fromAgent: string;
  fromSessionId: string;
  messageType: WorkflowRouteMessageType;
  resolvedRole: string;
  requestId: string;
  messageId: string;
  createdAt: string;
  taskId?: string;
  content: string;
  parentRequestId?: string;
  discuss?: { threadId?: string; requestId?: string };
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
