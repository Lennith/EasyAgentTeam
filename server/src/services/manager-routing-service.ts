import { randomUUID } from "node:crypto";
import type { ManagerToAgentMessage, ProjectPaths, ProjectRecord } from "../domain/models.js";
import { appendEvent } from "../data/event-store.js";
import { appendInboxMessage } from "../data/inbox-store.js";
import { setRoleSessionMapping } from "../data/project-store.js";
import { addSession, getSession, touchSession } from "../data/session-store.js";
import { listTasks } from "../data/taskboard-store.js";
import {
  validateExplicitTargetSession,
  validateRoleSessionMapWrite,
  type RoutingRejectCode
} from "./routing-guard-service.js";
import { resolveTaskDiscuss } from "./orchestrator-service.js";
import { resolveActiveSessionForRole } from "./session-lifecycle-authority.js";

export interface DeliverManagerMessageInput {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  message: ManagerToAgentMessage;
  targetRole?: string;
  targetSessionId?: string;
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
  dataRoot: string,
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

  const active = await resolveActiveSessionForRole({
    dataRoot,
    project,
    paths,
    role,
    reason: "manager_deliver_message"
  });
  if (active) {
    return { sessionId: active.sessionId, sessionExisted: true };
  }

  const safeRole = role.replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const newSessionId = `session-${safeRole}-${randomUUID().slice(0, 12)}`;
  const roleProviderId = project.agentModelConfigs?.[role]?.provider_id ?? "minimax";
  await addSession(paths, projectId, {
    sessionId: newSessionId,
    role,
    status: "idle",
    providerSessionId: undefined,
    provider: roleProviderId
  });
  return { sessionId: newSessionId, sessionExisted: false };
}

export async function deliverManagerMessage(
  input: DeliverManagerMessageInput
): Promise<{ sessionExisted: boolean; sessionId: string }> {
  const role = (input.targetRole ?? input.message.envelope.accountability?.owner_role ?? "").trim();
  const requestedSessionId = input.targetSessionId;
  const target = await getOrCreateSession(
    input.dataRoot,
    input.paths,
    input.project.projectId,
    role,
    input.project,
    requestedSessionId
  );
  const targetSessionId = target.sessionId;
  const currentTaskId = input.currentTaskId === undefined ? undefined : (input.currentTaskId ?? null);
  const currentTaskIdForAdd = typeof currentTaskId === "string" ? currentTaskId : undefined;

  const allTasks = await listTasks(input.paths, input.project.projectId);
  const resolvedMessage = resolveTaskDiscuss(input.message, role, allTasks);

  await appendInboxMessage(input.paths, role, resolvedMessage);
  const existing = await getSession(input.paths, input.project.projectId, targetSessionId);
  if (existing) {
    await touchSession(input.paths, input.project.projectId, targetSessionId, {
      role: role || existing.role,
      ...(currentTaskId !== undefined ? { currentTaskId } : {})
    });
  } else {
    const fallbackRole = role || "unknown";
    const fallbackProvider = input.project.agentModelConfigs?.[fallbackRole]?.provider_id ?? "minimax";
    await addSession(input.paths, input.project.projectId, {
      sessionId: targetSessionId,
      role: fallbackRole,
      status: "idle",
      provider: fallbackProvider,
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
