import type { ManagerToAgentMessage, ProjectPaths, ProjectRecord, SessionStatus } from "../domain/models.js";
import { appendEvent } from "../data/event-store.js";
import { appendInboxMessage } from "../data/inbox-store.js";
import { setRoleSessionMapping } from "../data/project-store.js";
import { addSession, getSession, listSessions, touchSession } from "../data/session-store.js";
import { listTasks } from "../data/taskboard-store.js";
import {
  validateExplicitTargetSession,
  validateRoleSessionMapWrite,
  type RoutingRejectCode
} from "./routing-guard-service.js";
import { resolveTaskDiscuss } from "./orchestrator-service.js";

export interface DeliverManagerMessageInput {
  dataRoot?: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  message: ManagerToAgentMessage;
  targetRole?: string;
  targetSessionId?: string;
  sessionStatus?: SessionStatus;
  currentTaskId?: string | null;
  updateRoleSessionMap?: boolean;
}

export class ManagerRoutingError extends Error {
  constructor(
    message: string,
    public readonly code: RoutingRejectCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

async function getOrCreateSession(
  paths: ProjectPaths,
  projectId: string,
  role: string,
  project: ProjectRecord,
  requestedSessionId?: string
): Promise<{ sessionId: string; sessionExisted: boolean }> {
  if (requestedSessionId) {
    const validated = await validateExplicitTargetSession(paths, projectId, requestedSessionId, role || undefined);
    if (!validated.ok) {
      throw new ManagerRoutingError(validated.error.message, validated.error.code, validated.error.details);
    }
    return { sessionId: validated.sessionId, sessionExisted: true };
  }

  const sessions = await listSessions(paths, projectId);
  const roleSessions = sessions.filter(s => s.role === role);
  if (roleSessions.length > 0) {
    roleSessions.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
    return { sessionId: roleSessions[0].sessionId, sessionExisted: true };
  }

  const safeRole = role.replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const newSessionId = `pending-${safeRole}-${Math.random().toString(36).slice(2, 10)}`;
  const roleAgentTool = project.agentModelConfigs?.[role]?.tool ?? "codex";
  await addSession(paths, projectId, {
    sessionId: newSessionId,
    sessionKey: newSessionId,
    role,
    status: "idle",
    provider: "codex",
    providerSessionId: undefined,
    agentTool: roleAgentTool as "codex" | "trae" | "minimax"
  });
  return { sessionId: newSessionId, sessionExisted: false };
}

export async function deliverManagerMessage(input: DeliverManagerMessageInput): Promise<{ sessionExisted: boolean; sessionId: string }> {
  const role = (input.targetRole ?? input.message.envelope.accountability?.owner_role ?? "").trim();
  const requestedSessionId = input.targetSessionId;
  const target = await getOrCreateSession(input.paths, input.project.projectId, role, input.project, requestedSessionId);
  const targetSessionId = target.sessionId;
  
  const status = input.sessionStatus ?? "idle";
  const currentTaskId = input.currentTaskId === undefined ? undefined : input.currentTaskId ?? null;
  const currentTaskIdForAdd = typeof currentTaskId === "string" ? currentTaskId : undefined;

  const allTasks = await listTasks(input.paths, input.project.projectId);
  const resolvedMessage = resolveTaskDiscuss(input.message, role, allTasks);

  await appendInboxMessage(input.paths, role, resolvedMessage);
  const existing = await getSession(input.paths, input.project.projectId, targetSessionId);
  if (existing) {
    await touchSession(input.paths, input.project.projectId, targetSessionId, {
      role: role || existing.role,
      status,
      ...(currentTaskId !== undefined ? { currentTaskId } : {})
    });
  } else {
    await addSession(input.paths, input.project.projectId, {
      sessionId: targetSessionId,
      role: role || "unknown",
      status,
      ...(currentTaskIdForAdd !== undefined ? { currentTaskId: currentTaskIdForAdd } : {})
    });
  }

  const shouldUpdateMap = input.updateRoleSessionMap ?? true;
  if (shouldUpdateMap && input.dataRoot && role) {
    const mapWriteError = validateRoleSessionMapWrite(role, targetSessionId);
    if (mapWriteError) {
      await appendEvent(input.paths, {
        projectId: input.project.projectId,
        eventType: "ROLE_SESSION_MAPPING_REJECTED",
        source: "manager",
        sessionId: targetSessionId,
        taskId: typeof input.message.body.taskId === "string" ? input.message.body.taskId : undefined,
        payload: {
          role,
          targetSessionId,
          reason: mapWriteError.message,
          errorCode: mapWriteError.code
        }
      });
    } else {
      await setRoleSessionMapping(input.dataRoot, input.project.projectId, role, targetSessionId);
    }
  }

  return { sessionExisted: target.sessionExisted || Boolean(existing), sessionId: targetSessionId };
}
