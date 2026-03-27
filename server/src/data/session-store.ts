import type {
  PendingConfirmedMessage,
  ProjectPaths,
  SessionRecord,
  SessionStatus,
  SessionsState
} from "../domain/models.js";
import type { ProviderId } from "@autodev/agent-library";
import { readJsonFile, writeJsonFile } from "./store/store-runtime.js";

const VALID_SESSION_STATUS = new Set<SessionStatus>(["running", "idle", "blocked", "dismissed"]);

class ProjectWriteMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const waitFor = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await waitFor.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const projectWriteMutexes = new Map<string, ProjectWriteMutex>();

function getProjectWriteMutex(projectId: string): ProjectWriteMutex {
  const existing = projectWriteMutexes.get(projectId);
  if (existing) {
    return existing;
  }
  const created = new ProjectWriteMutex();
  projectWriteMutexes.set(projectId, created);
  return created;
}

async function withProjectWriteLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  return getProjectWriteMutex(projectId).runExclusive(operation);
}

export class SessionStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_SESSION_ID"
      | "INVALID_ROLE"
      | "INVALID_STATUS"
      | "SESSION_EXISTS"
      | "SESSION_NOT_FOUND"
      | "SESSION_ROLE_CONFLICT"
  ) {
    super(message);
  }
}

function defaultSessionsState(projectId: string): SessionsState {
  return {
    schemaVersion: "1.0",
    projectId,
    updatedAt: new Date().toISOString(),
    sessions: []
  };
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized || !/^[a-zA-Z0-9._:-]+$/.test(normalized)) {
    throw new SessionStoreError("session_id is invalid", "INVALID_SESSION_ID");
  }
  return normalized;
}

function normalizeRole(role: string): string {
  const normalized = role.trim();
  if (!normalized) {
    throw new SessionStoreError("role is required", "INVALID_ROLE");
  }
  return normalized;
}

function normalizeStatus(status?: string): SessionStatus {
  const normalized = (status ?? "idle").toLowerCase() as SessionStatus;
  if (!VALID_SESSION_STATUS.has(normalized)) {
    throw new SessionStoreError(`status '${status}' is invalid`, "INVALID_STATUS");
  }
  return normalized;
}

export async function readSessionsState(
  paths: ProjectPaths,
  projectId: string
): Promise<SessionsState> {
  return readJsonFile<SessionsState>(paths.sessionsFile, defaultSessionsState(projectId));
}

export async function listSessions(paths: ProjectPaths, projectId: string): Promise<SessionRecord[]> {
  const state = await readSessionsState(paths, projectId);
  return state.sessions;
}

export async function addSession(
  paths: ProjectPaths,
  projectId: string,
  input: {
    sessionId: string;
    role: string;
    status?: string;
    currentTaskId?: string;
    lastInboxMessageId?: string;
    lastDispatchedAt?: string;
    provider?: ProviderId;
    providerSessionId?: string;
    allowRoleConflict?: boolean;
    timeoutStreak?: number;
    errorStreak?: number;
    lastFailureAt?: string;
    lastFailureKind?: "timeout" | "error";
    lastRunId?: string;
    lastDispatchId?: string;
    cooldownUntil?: string;
  }
): Promise<{ session: SessionRecord; created: boolean }> {
  return withProjectWriteLock(projectId, async () => {
    const state = await readSessionsState(paths, projectId);
    const sessionId = normalizeSessionId(input.sessionId);
    const normalizedRole = normalizeRole(input.role);
    if (input.allowRoleConflict === false) {
      const hasActiveSameRole = state.sessions.some((item) => item.role === normalizedRole && item.status !== "dismissed");
      if (hasActiveSameRole) {
        throw new SessionStoreError(`role '${normalizedRole}' already has active session`, "SESSION_ROLE_CONFLICT");
      }
    }
    const idx = state.sessions.findIndex((item) => item.sessionId === sessionId);
    const now = new Date().toISOString();

    if (idx >= 0) {
      const existing = state.sessions[idx];
      const updated: SessionRecord = {
        ...existing,
        role: normalizedRole,
        status: normalizeStatus(input.status ?? existing.status),
        currentTaskId: input.currentTaskId?.trim() || existing.currentTaskId,
        lastInboxMessageId: input.lastInboxMessageId?.trim() || existing.lastInboxMessageId,
        lastDispatchedAt: input.lastDispatchedAt?.trim() || existing.lastDispatchedAt,
        providerSessionId: input.providerSessionId?.trim() || existing.providerSessionId,
        provider: input.provider || existing.provider || "codex",
        timeoutStreak: input.timeoutStreak ?? existing.timeoutStreak,
        errorStreak: input.errorStreak ?? existing.errorStreak,
        lastFailureAt: input.lastFailureAt ?? existing.lastFailureAt,
        lastFailureKind: input.lastFailureKind ?? existing.lastFailureKind,
        lastRunId: input.lastRunId ?? existing.lastRunId,
        lastDispatchId: input.lastDispatchId ?? existing.lastDispatchId,
        cooldownUntil: input.cooldownUntil ?? existing.cooldownUntil,
        updatedAt: now,
        lastActiveAt: now
      };
      state.sessions[idx] = updated;
      state.updatedAt = now;
      await writeJsonFile(paths.sessionsFile, state);
      return { session: updated, created: false };
    }

    const session: SessionRecord = {
      schemaVersion: "1.0",
      sessionId,
      projectId,
      role: normalizedRole,
      provider: input.provider || "codex",
      providerSessionId: input.providerSessionId?.trim() || undefined,
      status: normalizeStatus(input.status),
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
      currentTaskId: input.currentTaskId?.trim() || undefined,
      lastInboxMessageId: input.lastInboxMessageId?.trim() || undefined,
      lastDispatchedAt: input.lastDispatchedAt?.trim() || undefined,
      timeoutStreak: input.timeoutStreak,
      errorStreak: input.errorStreak,
      lastFailureAt: input.lastFailureAt,
      lastFailureKind: input.lastFailureKind,
      lastRunId: input.lastRunId,
      lastDispatchId: input.lastDispatchId,
      cooldownUntil: input.cooldownUntil
    };
    state.sessions.push(session);
    state.updatedAt = now;
    await writeJsonFile(paths.sessionsFile, state);
    return { session, created: true };
  });
}

export async function getSession(
  paths: ProjectPaths,
  projectId: string,
  sessionId: string
): Promise<SessionRecord | null> {
  const state = await readSessionsState(paths, projectId);
  const normalized = normalizeSessionId(sessionId);
  return state.sessions.find((item) => item.sessionId === normalized) ?? null;
}

export async function touchSession(
  paths: ProjectPaths,
  projectId: string,
  sessionId: string,
  patch: {
    status?: string;
    role?: string;
    currentTaskId?: string | null;
    lastActiveAt?: string;
    lastInboxMessageId?: string | null;
    lastDispatchedAt?: string | null;
    providerSessionId?: string | null;
    provider?: ProviderId | null;
    agentPid?: number | null;
    pendingConfirmedMessages?: PendingConfirmedMessage[] | null;
    confirmedMessageIds?: string[] | null;
    timeoutStreak?: number | null;
    errorStreak?: number | null;
    lastFailureAt?: string | null;
    lastFailureKind?: "timeout" | "error" | null;
    lastRunId?: string | null;
    lastDispatchId?: string | null;
    cooldownUntil?: string | null;
  } = {}
): Promise<SessionRecord> {
  return withProjectWriteLock(projectId, async () => {
    const state = await readSessionsState(paths, projectId);
    const normalized = normalizeSessionId(sessionId);
    const idx = state.sessions.findIndex((item) => item.sessionId === normalized);
    if (idx < 0) {
      throw new SessionStoreError(`session '${normalized}' not found`, "SESSION_NOT_FOUND");
    }

    const existing = state.sessions[idx];
    const now = new Date().toISOString();
    let updated: SessionRecord = {
      ...existing,
      role: patch.role ? normalizeRole(patch.role) : existing.role,
      status: patch.status ? normalizeStatus(patch.status) : existing.status,
      currentTaskId:
        patch.currentTaskId === null
          ? undefined
          : patch.currentTaskId?.trim() || existing.currentTaskId,
      lastInboxMessageId:
        patch.lastInboxMessageId === null
          ? undefined
          : patch.lastInboxMessageId?.trim() || existing.lastInboxMessageId,
      lastDispatchedAt:
        patch.lastDispatchedAt === null
          ? undefined
          : patch.lastDispatchedAt?.trim() || existing.lastDispatchedAt,
      providerSessionId:
        patch.providerSessionId === null ? undefined : patch.providerSessionId?.trim() || existing.providerSessionId,
      provider:
        patch.provider === null ? existing.provider : patch.provider || existing.provider,
      agentPid:
        patch.agentPid === null ? undefined : patch.agentPid ?? existing.agentPid,
      pendingConfirmedMessages:
        patch.pendingConfirmedMessages === null
          ? undefined
          : patch.pendingConfirmedMessages ?? existing.pendingConfirmedMessages,
      confirmedMessageIds:
        patch.confirmedMessageIds === null
          ? undefined
          : patch.confirmedMessageIds ?? existing.confirmedMessageIds,
      timeoutStreak:
        patch.timeoutStreak === null
          ? undefined
          : patch.timeoutStreak ?? existing.timeoutStreak,
      errorStreak:
        patch.errorStreak === null
          ? undefined
          : patch.errorStreak ?? existing.errorStreak,
      lastFailureAt:
        patch.lastFailureAt === null
          ? undefined
          : patch.lastFailureAt ?? existing.lastFailureAt,
      lastFailureKind:
        patch.lastFailureKind === null
          ? undefined
          : patch.lastFailureKind ?? existing.lastFailureKind,
      lastRunId:
        patch.lastRunId === null
          ? undefined
          : patch.lastRunId ?? existing.lastRunId,
      lastDispatchId:
        patch.lastDispatchId === null
          ? undefined
          : patch.lastDispatchId ?? existing.lastDispatchId,
      cooldownUntil:
        patch.cooldownUntil === null
          ? undefined
          : patch.cooldownUntil ?? existing.cooldownUntil,
      updatedAt: now,
      lastActiveAt: patch.lastActiveAt ?? now
    };
    if (updated.status !== "running") {
      updated = {
        ...updated,
        agentPid: undefined
      };
    }
    state.sessions[idx] = updated;
    state.updatedAt = now;
    await writeJsonFile(paths.sessionsFile, state);
    return updated;
  });
}

export async function resolveLatestSessionByRole(
  paths: ProjectPaths,
  projectId: string,
  role: string
): Promise<SessionRecord | null> {
  const state = await readSessionsState(paths, projectId);
  const normalizedRole = normalizeRole(role);
  const candidates = state.sessions
    .filter((item) => item.role === normalizedRole && item.status !== "dismissed")
    .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
  return candidates[0] ?? null;
}
