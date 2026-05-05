import { isManagerChatMessageType } from "../domain/models.js";
import { ProjectMessageSendRequestSchema } from "@autodev/agent-library";
import type { ProjectPaths, ProjectRecord } from "../domain/models.js";
import { getProjectRepositoryBundle } from "../data/repository/project/repository-bundle.js";
import { validateExplicitTargetSession } from "./routing-guard-service.js";
import { createTimestampRequestId } from "./orchestrator/shared/orchestrator-identifiers.js";
import { normalizeOrchestratorDiscussReference } from "./orchestrator/shared/manager-message-contract.js";
import {
  routeProjectManagerMessage,
  type ProjectRouteMessageType
} from "./orchestrator/project/project-message-routing-service.js";
import { resolveTargetSession } from "./task-actions/shared.js";

function readStringField(body: Record<string, unknown>, keys: string[], fallback?: string): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return fallback;
}

function detectEncodingCorruption(content: string): string | null {
  if (content.includes("\uFFFD")) {
    return "content contains replacement character (\uFFFD)";
  }
  const compact = content.replace(/\s+/g, "");
  if (!compact) {
    return null;
  }
  const hasTripleQuestionGroup = /\?{3,}/.test(content);
  if (!hasTripleQuestionGroup) {
    return null;
  }
  const questionCount = [...compact].filter((ch) => ch === "?").length;
  const ratio = questionCount / compact.length;
  if (ratio >= 0.15) {
    return `content has high '?' ratio (${Math.round(ratio * 100)}%) with repeated '???'`;
  }
  return null;
}

export class ManagerMessageServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly nextAction?: string,
    public readonly details?: Record<string, unknown>,
    public readonly replacement?: string
  ) {
    super(message);
  }
}

export interface ManagerMessageSendResult {
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

export async function handleManagerMessageSend(
  dataRoot: string,
  project: ProjectRecord,
  paths: ProjectPaths,
  body: Record<string, unknown>
): Promise<ManagerMessageSendResult> {
  const repositories = getProjectRepositoryBundle(dataRoot);
  const modeRaw = (body.mode as string | undefined)?.toUpperCase();
  if (modeRaw === "TASK_ASSIGN") {
    throw new ManagerMessageServiceError(
      410,
      "ENDPOINT_RETIRED",
      "mode=TASK_ASSIGN is retired",
      undefined,
      undefined,
      "/api/projects/:id/task-actions"
    );
  }
  if (body.clarification !== undefined) {
    throw new ManagerMessageServiceError(
      400,
      "MESSAGE_CLARIFICATION_RETIRED",
      "clarification payload is retired; use discuss payload",
      "Move fields under discuss and use message_type=TASK_DISCUSS_*."
    );
  }

  const parsed = ProjectMessageSendRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ManagerMessageServiceError(
      400,
      "MESSAGE_INPUT_INVALID",
      "message payload is invalid",
      "Provide content and to.agent or to.session_id."
    );
  }

  const messageTypeRaw = parsed.data.messageType;
  if (!messageTypeRaw || !isManagerChatMessageType(messageTypeRaw)) {
    throw new ManagerMessageServiceError(
      400,
      "MESSAGE_TYPE_INVALID",
      "message_type is invalid",
      "Use MANAGER_MESSAGE or TASK_DISCUSS_REQUEST|TASK_DISCUSS_REPLY|TASK_DISCUSS_CLOSED."
    );
  }
  const messageType: ProjectRouteMessageType = messageTypeRaw;

  const toRole = parsed.data.toRole;
  const fromAgent = parsed.data.fromAgent;
  const fromSessionId = parsed.data.fromSessionId;
  const explicitSessionId = parsed.data.toSessionId;
  const content = parsed.data.content;
  const requestId = parsed.data.requestId ?? createTimestampRequestId();
  const parentRequestId = parsed.data.parentRequestId;
  const taskId = parsed.data.taskId;

  if (!toRole && !explicitSessionId) {
    throw new ManagerMessageServiceError(
      400,
      "MESSAGE_TARGET_REQUIRED",
      "to.agent (role) or to.session_id is required",
      "Pass to.agent for role routing or to.session_id for fixed session delivery."
    );
  }
  if (!content || !content.trim()) {
    throw new ManagerMessageServiceError(
      400,
      "MESSAGE_CONTENT_REQUIRED",
      "content is required",
      "Provide non-empty content."
    );
  }
  const encodingIssue = detectEncodingCorruption(content.trim());
  if (encodingIssue) {
    throw new ManagerMessageServiceError(
      400,
      "MESSAGE_ENCODING_INVALID",
      "message content appears encoding-corrupted",
      `Please resend UTF-8 text. Detected: ${encodingIssue}`
    );
  }

  let resolvedSessionId = explicitSessionId?.trim();
  let resolvedToRole = toRole?.trim() || undefined;
  if (resolvedSessionId) {
    const explicitValidation = await validateExplicitTargetSession(
      paths,
      project.projectId,
      resolvedSessionId,
      resolvedToRole
    );
    if (!explicitValidation.ok) {
      throw new ManagerMessageServiceError(
        409,
        explicitValidation.error.code,
        explicitValidation.error.message,
        undefined,
        explicitValidation.error.details
      );
    }
    resolvedSessionId = explicitValidation.sessionId;
    if (!resolvedToRole) {
      resolvedToRole = explicitValidation.resolvedRole;
    }
  }
  if (!resolvedSessionId && resolvedToRole) {
    resolvedSessionId = await resolveTargetSession(dataRoot, project, paths, resolvedToRole, undefined);
  }
  if (!resolvedSessionId) {
    throw new ManagerMessageServiceError(
      404,
      "MESSAGE_TARGET_SESSION_NOT_FOUND",
      "target session cannot be resolved",
      "Create/start target role session or pass an explicit valid to.session_id."
    );
  }
  if (!resolvedToRole) {
    const target = await repositories.sessions.getSession(paths, project.projectId, resolvedSessionId);
    resolvedToRole = target?.role;
  }
  if (resolvedToRole && !repositories.projectRuntime.isProjectRouteAllowed(project, fromAgent, resolvedToRole)) {
    await repositories.events.appendEvent(paths, {
      projectId: project.projectId,
      eventType: "MESSAGE_ROUTE_DENIED",
      source: "manager",
      sessionId: fromSessionId,
      taskId: taskId ?? undefined,
      payload: {
        fromRole: fromAgent,
        toRole: resolvedToRole,
        reason: "route_not_allowed"
      }
    });
    throw new ManagerMessageServiceError(
      403,
      "MESSAGE_ROUTE_DENIED",
      "route not allowed by project route table",
      "Request route-table update or choose an allowed target role."
    );
  }

  return await routeProjectManagerMessage({
    dataRoot,
    project,
    paths,
    fromAgent,
    fromSessionId,
    messageType,
    toRole: resolvedToRole ?? null,
    toSessionId: resolvedSessionId,
    requestId,
    parentRequestId: parentRequestId ?? null,
    taskId: taskId ?? null,
    content: content.trim(),
    discuss: normalizeOrchestratorDiscussReference(body.discuss)
  });
}
