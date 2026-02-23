import type {
  ProjectPaths,
  SessionRecord,
  SessionStatus,
  SessionsState,
  PendingConfirmedMessage
} from "../domain/models.js";
import fs from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "./file-utils.js";

const VALID_SESSION_STATUS = new Set<SessionStatus>(["running", "idle", "blocked", "dismissed"]);

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

function normalizeSessionKey(sessionKey: string): string {
  const normalized = sessionKey.trim();
  if (!normalized || !/^[a-zA-Z0-9._:-]+$/.test(normalized)) {
    throw new SessionStoreError("session_key is invalid", "INVALID_SESSION_ID");
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
    sessionKey?: string;
    role: string;
    status?: string;
    currentTaskId?: string;
    lastInboxMessageId?: string;
    lastDispatchedAt?: string;
    provider?: "codex";
    providerSessionId?: string;
    agentTool?: "codex" | "trae" | "minimax";
    allowRoleConflict?: boolean;
  }
): Promise<{ session: SessionRecord; created: boolean }> {
  const state = await readSessionsState(paths, projectId);
  const sessionId = normalizeSessionId(input.sessionId);
  const sessionKey = input.sessionKey?.trim() ? normalizeSessionKey(input.sessionKey) : undefined;
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
      sessionKey: sessionKey ?? existing.sessionKey,
      provider: "codex",
      providerSessionId: input.providerSessionId?.trim() || existing.providerSessionId,
      agentTool: input.agentTool || existing.agentTool || "codex",
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
    sessionKey,
    projectId,
    role: normalizedRole,
    provider: "codex",
    providerSessionId: input.providerSessionId?.trim() || undefined,
    status: normalizeStatus(input.status),
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
    currentTaskId: input.currentTaskId?.trim() || undefined,
    lastInboxMessageId: input.lastInboxMessageId?.trim() || undefined,
    lastDispatchedAt: input.lastDispatchedAt?.trim() || undefined,
    agentTool: input.agentTool || "codex"
  };
  state.sessions.push(session);
  state.updatedAt = now;
  await writeJsonFile(paths.sessionsFile, state);
  return { session, created: true };
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
    sessionKey?: string | null;
    providerSessionId?: string | null;
    agentTool?: "codex" | "trae" | "minimax" | null;
    agentPid?: number | null;
    pendingConfirmedMessages?: PendingConfirmedMessage[] | null;
    confirmedMessageIds?: string[] | null;
  } = {}
): Promise<SessionRecord> {
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
    sessionKey:
      patch.sessionKey === null ? undefined : patch.sessionKey?.trim() || existing.sessionKey,
    providerSessionId:
      patch.providerSessionId === null ? undefined : patch.providerSessionId?.trim() || existing.providerSessionId,
    agentTool:
      patch.agentTool === null ? undefined : patch.agentTool || existing.agentTool,
    provider: "codex",
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

export async function resolveSessionByIdOrKey(
  paths: ProjectPaths,
  projectId: string,
  token: string
): Promise<SessionRecord | null> {
  const state = await readSessionsState(paths, projectId);
  const normalized = token.trim();
  if (!normalized) {
    return null;
  }
  const byId = state.sessions.find((item) => item.sessionId === normalized);
  if (byId) {
    return byId;
  }
  return state.sessions.find((item) => item.sessionKey === normalized) ?? null;
}

export async function promotePendingSessionToCodex(
  paths: ProjectPaths,
  projectId: string,
  pendingSessionId: string,
  codexSessionId: string
): Promise<SessionRecord> {
  const state = await readSessionsState(paths, projectId);
  const pending = normalizeSessionId(pendingSessionId);
  const codex = normalizeSessionId(codexSessionId);
  const idx = state.sessions.findIndex((item) => item.sessionId === pending);
  if (idx < 0) {
    throw new SessionStoreError(`session '${pending}' not found`, "SESSION_NOT_FOUND");
  }
  if (state.sessions.some((item, i) => i !== idx && item.sessionId === codex)) {
    throw new SessionStoreError(`session '${codex}' already exists`, "SESSION_EXISTS");
  }
  const now = new Date().toISOString();
  const existing = state.sessions[idx];
  const updated: SessionRecord = {
    ...existing,
    sessionId: codex,
    sessionKey: existing.sessionKey ?? pending,
    provider: "codex",
    providerSessionId: codex,
    updatedAt: now,
    lastActiveAt: now
  };
  state.sessions[idx] = updated;
  state.updatedAt = now;
  await writeJsonFile(paths.sessionsFile, state);

  const oldInbox = path.join(paths.inboxDir, `${pending}.jsonl`);
  const newInbox = path.join(paths.inboxDir, `${codex}.jsonl`);
  try {
    await fs.access(oldInbox);
    try {
      await fs.access(newInbox);
      // keep both if target exists
    } catch {
      await fs.rename(oldInbox, newInbox);
    }
  } catch {
    // no inbox file for pending session
  }

  return updated;
}
