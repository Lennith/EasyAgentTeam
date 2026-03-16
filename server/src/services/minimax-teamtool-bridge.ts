import { acquireLock, createProjectLockScope, listActiveLocks, releaseLock, renewLock } from "../data/lock-store.js";
import { listAgents } from "../data/agent-store.js";
import { buildProjectRoutingSnapshot } from "./project-routing-snapshot-service.js";
import { handleTaskAction, TaskActionError } from "./task-action-service.js";
import { handleManagerMessageSend, ManagerMessageServiceError } from "./manager-message-service.js";
import type { TeamToolBridge, TeamToolExecutionContext } from "../minimax/tools/team/types.js";

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function resolveTaskActionNextAction(code: string): string | null {
  switch (code) {
    case "TASK_PROGRESS_REQUIRED":
      return "Update Agents/<role>/progress.md with concrete evidence and task_id, then retry once.";
    case "TASK_RESULT_INVALID_TARGET":
      return "Report only tasks owned by your role or created by your role.";
    case "TASK_BINDING_REQUIRED":
      return "Fill required task binding fields (task_id, owner_role, or discuss target).";
    case "TASK_ROUTE_DENIED":
      return "Choose an allowed route target or request route-table update.";
    case "TASK_REPORT_NO_STATE_CHANGE":
      return "Do not resend identical report. Add new progress and evidence.";
    case "TASK_STATE_STALE":
      return "Task is already in a newer terminal state. Keep same-state report or continue downstream.";
    case "TASK_DEPENDENCY_NOT_READY":
      return "Wait until dependency tasks are DONE/CANCELED, then retry IN_PROGRESS/DONE report.";
    case "TASK_ACTION_INVALID":
      return "Fix payload schema for selected action_type and retry once.";
    default:
      return null;
  }
}

export class TeamToolBridgeError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly nextAction: string | null = null,
    public readonly raw?: unknown
  ) {
    super(message);
  }
}

export function createMiniMaxTeamToolBridge(context: TeamToolExecutionContext): TeamToolBridge {
  const lockScope = createProjectLockScope(context.dataRoot, context.project.projectId, context.project.workspacePath);
  return {
    async taskAction(requestBody: Record<string, unknown>): Promise<Record<string, unknown>> {
      try {
        const result = await handleTaskAction(context.dataRoot, context.project, context.paths, requestBody);
        return result as unknown as Record<string, unknown>;
      } catch (error) {
        if (error instanceof TaskActionError) {
          throw new TeamToolBridgeError(
            error.status,
            error.code,
            error.message,
            error.hint ?? resolveTaskActionNextAction(error.code),
            error.details
          );
        }
        throw new TeamToolBridgeError(
          500,
          "TASK_ACTION_BRIDGE_ERROR",
          error instanceof Error ? error.message : String(error)
        );
      }
    },

    async sendMessage(requestBody: Record<string, unknown>): Promise<Record<string, unknown>> {
      try {
        const result = await handleManagerMessageSend(context.dataRoot, context.project, context.paths, requestBody);
        return result as unknown as Record<string, unknown>;
      } catch (error) {
        if (error instanceof ManagerMessageServiceError) {
          throw new TeamToolBridgeError(
            error.status,
            error.code,
            error.message,
            error.hint ?? null,
            error.details ?? error.replacement
          );
        }
        throw new TeamToolBridgeError(
          500,
          "MANAGER_MESSAGE_BRIDGE_ERROR",
          error instanceof Error ? error.message : String(error)
        );
      }
    },

    async getRouteTargets(fromAgent: string): Promise<Record<string, unknown>> {
      const registry = await listAgents(context.dataRoot);
      const snapshot = buildProjectRoutingSnapshot(
        context.project,
        fromAgent,
        registry.map((item) => item.agentId)
      );
      return snapshot as unknown as Record<string, unknown>;
    },

    async lockAcquire(input: Record<string, unknown>): Promise<Record<string, unknown>> {
      const sessionId = readString(input.session_id ?? input.sessionId) ?? context.sessionId;
      const lockKey = readString(input.lock_key ?? input.lockKey);
      const ttlSeconds = readInteger(input.ttl_seconds ?? input.ttlSeconds) ?? 300;
      const targetTypeRaw = readString(input.target_type ?? input.targetType);
      const targetType = targetTypeRaw === "file" || targetTypeRaw === "dir" ? targetTypeRaw : undefined;
      const purpose = readString(input.purpose);
      if (!lockKey) {
        throw new TeamToolBridgeError(
          400,
          "LOCK_KEY_REQUIRED",
          "lock_key is required",
          "Set lock_key to a workspace-relative path."
        );
      }
      const acquired = await acquireLock(lockScope, {
        sessionId,
        lockKey,
        targetType,
        ttlSeconds,
        purpose
      });
      if (acquired.kind === "acquired") {
        return { result: "acquired", lock: acquired.lock };
      }
      if (acquired.kind === "stolen") {
        return { result: "stolen", lock: acquired.lock, previousLock: acquired.previousLock };
      }
      throw new TeamToolBridgeError(
        409,
        "LOCK_ACQUIRE_FAILED",
        acquired.reason,
        "Wait for lock expiry or choose a different file.",
        acquired.existingLock
      );
    },

    async lockRenew(input: Record<string, unknown>): Promise<Record<string, unknown>> {
      const sessionId = readString(input.session_id ?? input.sessionId) ?? context.sessionId;
      const lockKey = readString(input.lock_key ?? input.lockKey);
      if (!lockKey) {
        throw new TeamToolBridgeError(
          400,
          "LOCK_KEY_REQUIRED",
          "lock_key is required",
          "Set lock_key to renew (workspace-relative path)."
        );
      }
      const renewed = await renewLock(lockScope, { sessionId, lockKey });
      if (renewed.kind === "renewed") {
        return { result: "renewed", lock: renewed.lock };
      }
      if (renewed.kind === "not_found") {
        throw new TeamToolBridgeError(404, "LOCK_NOT_FOUND", "lock not found", "Acquire lock first.");
      }
      if (renewed.kind === "not_owner") {
        throw new TeamToolBridgeError(
          403,
          "LOCK_NOT_OWNER",
          "lock owned by another session",
          "Use owner session or reacquire after expiry.",
          renewed.existingLock
        );
      }
      throw new TeamToolBridgeError(
        409,
        "LOCK_EXPIRED",
        "lock expired",
        "Reacquire lock before editing.",
        renewed.existingLock
      );
    },

    async lockRelease(input: Record<string, unknown>): Promise<Record<string, unknown>> {
      const sessionId = readString(input.session_id ?? input.sessionId) ?? context.sessionId;
      const lockKey = readString(input.lock_key ?? input.lockKey);
      if (!lockKey) {
        throw new TeamToolBridgeError(
          400,
          "LOCK_KEY_REQUIRED",
          "lock_key is required",
          "Set lock_key to release (workspace-relative path)."
        );
      }
      const released = await releaseLock(lockScope, { sessionId, lockKey });
      if (released.kind === "released") {
        return { result: "released", lock: released.lock };
      }
      if (released.kind === "not_found") {
        throw new TeamToolBridgeError(404, "LOCK_NOT_FOUND", "lock not found", "Lock may already be released.");
      }
      throw new TeamToolBridgeError(
        403,
        "LOCK_NOT_OWNER",
        "lock owned by another session",
        "Only lock owner can release.",
        released.existingLock
      );
    },

    async lockList(): Promise<Record<string, unknown>> {
      const items = await listActiveLocks(lockScope);
      return { items, total: items.length };
    }
  };
}
