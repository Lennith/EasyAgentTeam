import { randomUUID } from "node:crypto";
import type { ProjectPaths, ProjectRecord } from "../domain/models.js";
import { appendEvent } from "../data/event-store.js";
import { clearRoleSessionMapping, isProjectRouteAllowed, setRoleSessionMapping } from "../data/project-store.js";
import { addSession, getSession } from "../data/session-store.js";
import {
  isReservedTargetSessionId,
  validateExplicitTargetSession,
  validateRoleSessionMapWrite
} from "./routing-guard-service.js";
import { deliverManagerMessage } from "./manager-routing-service.js";
import { emitMessageRouted, emitUserMessageReceived } from "./manager-routing-event-emitter-service.js";
import { resolveActiveSessionForRole } from "./session-lifecycle-authority.js";

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

function buildSessionId(role: string): string {
  const safeRole = role.replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return `session-${safeRole}-${randomUUID().slice(0, 12)}`;
}

async function resolveUsableSessionIdByRole(
  dataRoot: string,
  project: ProjectRecord,
  paths: ProjectPaths,
  role: string
): Promise<string | undefined> {
  const latest = await resolveActiveSessionForRole({
    dataRoot,
    project,
    paths,
    role,
    reason: "message_send"
  });
  if (latest && latest.status !== "dismissed" && !isReservedTargetSessionId(latest.sessionId)) {
    return latest.sessionId;
  }
  const mapped = project.roleSessionMap?.[role];
  if (!mapped) {
    return undefined;
  }
  await clearRoleSessionMapping(dataRoot, project.projectId, role);
  return undefined;
}

export class ManagerMessageServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly hint?: string,
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

  const messageType = readStringField(body, ["message_type", "messageType"], "MANAGER_MESSAGE");
  const validTypes = new Set(["MANAGER_MESSAGE", "TASK_DISCUSS_REQUEST", "TASK_DISCUSS_REPLY", "TASK_DISCUSS_CLOSED"]);
  if (!messageType || !validTypes.has(messageType)) {
    throw new ManagerMessageServiceError(
      400,
      "MESSAGE_TYPE_INVALID",
      "message_type is invalid",
      "Use MANAGER_MESSAGE or TASK_DISCUSS_REQUEST|TASK_DISCUSS_REPLY|TASK_DISCUSS_CLOSED."
    );
  }

  const to = (body.to ?? {}) as Record<string, unknown>;
  const toRole = (to.agent ?? to.role ?? body.to_role ?? body.to_agent) as string | undefined;
  const fromAgent = ((body.from_agent ?? body.fromAgent ?? "manager") as string).trim() || "manager";
  const fromSessionId =
    readStringField(body, ["from_session_id", "fromSessionId"]) ??
    (fromAgent === "manager" ? "manager-system" : "agent-session-unknown");
  const explicitSessionId = (to.session_id ?? body.session_id ?? body.to_session_id) as string | undefined;
  const content = body.content as string | undefined;
  const requestId = ((body.request_id ?? body.requestId) as string | undefined) ?? `${Date.now()}`;
  const parentRequestId = readStringField(body, ["parent_request_id", "parentRequestId"]);
  const taskId = readStringField(body, ["task_id", "taskId"]);

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
    resolvedSessionId = await resolveUsableSessionIdByRole(dataRoot, project, paths, resolvedToRole);
  }
  if (!resolvedSessionId && resolvedToRole) {
    const configuredTool = project.agentModelConfigs?.[resolvedToRole]?.tool;
    if (configuredTool && configuredTool !== "codex" && configuredTool !== "trae" && configuredTool !== "minimax") {
      throw new ManagerMessageServiceError(
        409,
        "SESSION_PROVIDER_NOT_SUPPORTED",
        `role '${resolvedToRole}' is configured with unsupported tool '${configuredTool}'`,
        "Only codex, trae, and minimax providers are supported for session startup."
      );
    }
    resolvedSessionId = buildSessionId(resolvedToRole);
    const resolvedAgentTool = project.agentModelConfigs?.[resolvedToRole]?.tool ?? "codex";
    await addSession(paths, project.projectId, {
      sessionId: resolvedSessionId,
      role: resolvedToRole,
      status: "idle",
      providerSessionId: undefined,
      provider: resolvedAgentTool as "codex" | "trae" | "minimax"
    });
    const mappingError = validateRoleSessionMapWrite(resolvedToRole, resolvedSessionId);
    if (!mappingError) {
      await setRoleSessionMapping(dataRoot, project.projectId, resolvedToRole, resolvedSessionId);
    }
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
    const target = await getSession(paths, project.projectId, resolvedSessionId);
    resolvedToRole = target?.role;
  }
  if (resolvedToRole && !isProjectRouteAllowed(project, fromAgent, resolvedToRole)) {
    await appendEvent(paths, {
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

  const messageId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const intent = messageType.startsWith("TASK_DISCUSS") ? "TASK_DISCUSS" : "MANAGER_MESSAGE";
  const managerMessage = {
    envelope: {
      message_id: messageId,
      project_id: project.projectId,
      timestamp: new Date().toISOString(),
      sender: {
        type: fromAgent === "manager" ? ("system" as const) : ("agent" as const),
        role: fromAgent,
        session_id: fromSessionId
      },
      via: { type: "manager" as const },
      intent,
      priority: "normal" as const,
      correlation: {
        request_id: requestId,
        parent_request_id: parentRequestId,
        task_id: taskId
      },
      accountability: {
        owner_role: resolvedToRole ?? "unknown",
        report_to: { role: fromAgent, session_id: fromSessionId },
        expect: messageType === "TASK_DISCUSS_REQUEST" ? ("DISCUSS_REPLY" as const) : ("TASK_REPORT" as const)
      },
      dispatch_policy: "fixed_session" as const
    },
    body: {
      content: content.trim(),
      mode: "CHAT",
      messageType,
      taskId,
      discuss: body.discuss ?? null
    }
  };

  await deliverManagerMessage({
    dataRoot,
    project,
    paths,
    message: managerMessage,
    targetRole: resolvedToRole,
    targetSessionId: resolvedSessionId,
    updateRoleSessionMap: Boolean(resolvedToRole)
  });

  await emitUserMessageReceived(
    { projectId: project.projectId, paths, source: "manager", taskId },
    {
      requestId,
      parentRequestId,
      content: content.trim(),
      toRole: resolvedToRole ?? null,
      fromAgent,
      mode: "CHAT",
      messageType,
      taskId,
      discuss: body.discuss ?? null
    }
  );
  await emitMessageRouted(
    { projectId: project.projectId, paths, source: "manager", sessionId: resolvedSessionId, taskId },
    {
      requestId,
      parentRequestId,
      toRole: resolvedToRole ?? null,
      resolvedSessionId,
      messageId,
      mode: "CHAT",
      messageType,
      taskId,
      discuss: body.discuss ?? null,
      content: content.trim()
    }
  );

  return {
    requestId,
    parentRequestId: parentRequestId ?? null,
    messageId,
    messageType,
    taskId: taskId ?? null,
    toRole: resolvedToRole ?? null,
    resolvedSessionId,
    mode: "CHAT",
    createdAt: new Date().toISOString()
  };
}
