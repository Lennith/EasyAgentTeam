import {
  acquireLock,
  listActiveLocks,
  releaseLock,
  renewLock,
  type LockScope
} from "../data/repository/project/lock-repository.js";
import type { TeamToolBridge } from "../minimax/tools/team/types.js";

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

export function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readInteger(value: unknown): number | undefined {
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

export function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function readStringList(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((item) => String(item).trim()).filter((item) => item.length > 0);
  }
  if (typeof input === "string") {
    return input
      .split(/[,\n\r|]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

export function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function asStatus(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 100 && value <= 599) {
    return Math.floor(value);
  }
  return fallback;
}

export function asCode(value: unknown, fallback: string): string {
  const code = readString(value);
  return code ?? fallback;
}

interface CreateMiniMaxTeamToolBridgeBaseInput {
  lockScope: LockScope;
  defaultSessionId: string;
  taskAction(requestBody: Record<string, unknown>): Promise<Record<string, unknown>>;
  sendMessage(requestBody: Record<string, unknown>): Promise<Record<string, unknown>>;
  getRouteTargets(fromAgent: string): Promise<Record<string, unknown>>;
}

function createMiniMaxTeamToolLockBridge(
  lockScope: LockScope,
  defaultSessionId: string
): Pick<TeamToolBridge, "lockAcquire" | "lockRenew" | "lockRelease" | "lockList"> {
  return {
    async lockAcquire(input: Record<string, unknown>): Promise<Record<string, unknown>> {
      const sessionId = readString(input.session_id ?? input.sessionId) ?? defaultSessionId;
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
      const sessionId = readString(input.session_id ?? input.sessionId) ?? defaultSessionId;
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
      const sessionId = readString(input.session_id ?? input.sessionId) ?? defaultSessionId;
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

export function createMiniMaxTeamToolBridgeBase(input: CreateMiniMaxTeamToolBridgeBaseInput): TeamToolBridge {
  return {
    taskAction: input.taskAction,
    sendMessage: input.sendMessage,
    getRouteTargets: input.getRouteTargets,
    ...createMiniMaxTeamToolLockBridge(input.lockScope, input.defaultSessionId)
  };
}
