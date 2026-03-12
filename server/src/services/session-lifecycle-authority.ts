import { appendEvent } from "../data/event-store.js";
import { clearRoleSessionMapping, setRoleSessionMapping } from "../data/project-store.js";
import { getSession, listSessions, touchSession } from "../data/session-store.js";
import type { ProviderId } from "@autodev/agent-library";
import type { ProjectPaths, ProjectRecord, SessionRecord } from "../domain/models.js";
import { isMiniMaxRunnerActive } from "./minimax-runner.js";

const DEFAULT_TIMEOUT_ESCALATION_THRESHOLD = 3;
const DEFAULT_TIMEOUT_COOLDOWN_MS = 0;

interface ResolveActiveSessionInput {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  role: string;
  reason: string;
}

interface RunnerLifecycleBaseInput {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  sessionId: string;
  runId?: string;
  dispatchId?: string;
  taskId?: string;
  messageId?: string;
  providerSessionId?: string | null;
  provider?: ProviderId;
}

interface RunnerErrorInput extends RunnerLifecycleBaseInput {
  error: string;
}

function parseTimestampMs(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortByRecent(a: SessionRecord, b: SessionRecord): number {
  const aKey = Math.max(parseTimestampMs(a.lastActiveAt), parseTimestampMs(a.updatedAt), parseTimestampMs(a.createdAt));
  const bKey = Math.max(parseTimestampMs(b.lastActiveAt), parseTimestampMs(b.updatedAt), parseTimestampMs(b.createdAt));
  if (aKey !== bKey) {
    return bKey - aKey;
  }
  return a.sessionId.localeCompare(b.sessionId);
}

function isRunnerActiveSession(session: SessionRecord): boolean {
  if (session.status !== "running") {
    return false;
  }
  if (session.provider === "minimax") {
    return isMiniMaxRunnerActive(session.sessionId);
  }
  return true;
}

export function getTimeoutEscalationThreshold(): number {
  const raw = Number(process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD ?? DEFAULT_TIMEOUT_ESCALATION_THRESHOLD);
  if (!Number.isFinite(raw) || raw < 1) {
    return DEFAULT_TIMEOUT_ESCALATION_THRESHOLD;
  }
  return Math.floor(raw);
}

export function getTimeoutCooldownMs(): number {
  const raw = Number(process.env.SESSION_TIMEOUT_COOLDOWN_MS ?? DEFAULT_TIMEOUT_COOLDOWN_MS);
  if (!Number.isFinite(raw) || raw < 0) {
    return DEFAULT_TIMEOUT_COOLDOWN_MS;
  }
  return Math.floor(raw);
}

function pickWinner(sessions: SessionRecord[], mappedSessionId?: string): SessionRecord {
  const activeRunner = sessions.filter(isRunnerActiveSession).sort(sortByRecent);
  if (activeRunner.length > 0) {
    return activeRunner[0];
  }
  if (mappedSessionId) {
    const mapped = sessions.find((item) => item.sessionId === mappedSessionId);
    if (mapped) {
      return mapped;
    }
  }
  return [...sessions].sort(sortByRecent)[0];
}

export async function resolveActiveSessionForRole(input: ResolveActiveSessionInput): Promise<SessionRecord | null> {
  const normalizedRole = input.role.trim();
  if (!normalizedRole) {
    return null;
  }

  const sessions = await listSessions(input.paths, input.project.projectId);
  const roleSessions = sessions.filter((item) => item.role === normalizedRole && item.status !== "dismissed");
  if (roleSessions.length === 0) {
    if (input.project.roleSessionMap?.[normalizedRole]) {
      await clearRoleSessionMapping(input.dataRoot, input.project.projectId, normalizedRole);
      const nextMap = { ...(input.project.roleSessionMap ?? {}) };
      delete nextMap[normalizedRole];
      input.project.roleSessionMap = Object.keys(nextMap).length > 0 ? nextMap : undefined;
    }
    return null;
  }

  const mappedSessionId = input.project.roleSessionMap?.[normalizedRole];
  const winner = pickWinner(roleSessions, mappedSessionId);
  const losers = roleSessions.filter((item) => item.sessionId !== winner.sessionId);

  if (losers.length > 0) {
    await appendEvent(input.paths, {
      projectId: input.project.projectId,
      eventType: "ROLE_SESSION_CONFLICT_DETECTED",
      source: "manager",
      sessionId: winner.sessionId,
      payload: {
        role: normalizedRole,
        reason: input.reason,
        winnerSessionId: winner.sessionId,
        loserSessionIds: losers.map((item) => item.sessionId)
      }
    });

    for (const loser of losers) {
      await touchSession(input.paths, input.project.projectId, loser.sessionId, {
        status: "dismissed",
        currentTaskId: null,
        agentPid: null
      });
      await appendEvent(input.paths, {
        projectId: input.project.projectId,
        eventType: "DISPATCH_CLOSED_BY_CONFLICT",
        source: "manager",
        sessionId: loser.sessionId,
        taskId: loser.currentTaskId,
        payload: {
          role: normalizedRole,
          winnerSessionId: winner.sessionId,
          loserSessionId: loser.sessionId,
          dispatchId: loser.lastDispatchId ?? null,
          runId: loser.lastRunId ?? null
        }
      });
    }
  }

  const mappedChanged = mappedSessionId !== winner.sessionId;
  if (mappedChanged) {
    await setRoleSessionMapping(input.dataRoot, input.project.projectId, normalizedRole, winner.sessionId);
    input.project.roleSessionMap = {
      ...(input.project.roleSessionMap ?? {}),
      [normalizedRole]: winner.sessionId
    };
  }

  if (losers.length > 0 || mappedChanged) {
    await appendEvent(input.paths, {
      projectId: input.project.projectId,
      eventType: "ROLE_SESSION_CONFLICT_RESOLVED",
      source: "manager",
      sessionId: winner.sessionId,
      payload: {
        role: normalizedRole,
        reason: input.reason,
        activeSessionId: winner.sessionId,
        dismissedSessionIds: losers.map((item) => item.sessionId),
        roleSessionMapUpdated: mappedChanged
      }
    });
  }

  return getSession(input.paths, input.project.projectId, winner.sessionId);
}

export async function markRunnerStarted(input: RunnerLifecycleBaseInput): Promise<SessionRecord | null> {
  const existing = await getSession(input.paths, input.project.projectId, input.sessionId);
  if (!existing) {
    return null;
  }
  const now = new Date().toISOString();
  const updated = await touchSession(input.paths, input.project.projectId, existing.sessionId, {
    status: "running",
    currentTaskId: input.taskId ?? existing.currentTaskId ?? null,
    lastInboxMessageId: input.messageId ?? existing.lastInboxMessageId ?? null,
    lastDispatchedAt: now,
    providerSessionId: input.providerSessionId === undefined ? existing.providerSessionId : input.providerSessionId,
    provider: input.provider ?? existing.provider ?? "minimax",
    lastRunId: input.runId ?? existing.lastRunId,
    lastDispatchId: input.dispatchId ?? existing.lastDispatchId,
    cooldownUntil: null
  });

  await resolveActiveSessionForRole({
    dataRoot: input.dataRoot,
    project: input.project,
    paths: input.paths,
    role: updated.role,
    reason: "runner_started"
  });

  return getSession(input.paths, input.project.projectId, updated.sessionId);
}

export async function markRunnerSuccess(input: RunnerLifecycleBaseInput): Promise<SessionRecord | null> {
  const existing = await getSession(input.paths, input.project.projectId, input.sessionId);
  if (!existing) {
    return null;
  }
  const now = new Date().toISOString();
  return touchSession(input.paths, input.project.projectId, existing.sessionId, {
    status: "idle",
    currentTaskId: input.taskId ?? existing.currentTaskId ?? null,
    lastInboxMessageId: input.messageId ?? existing.lastInboxMessageId ?? null,
    lastDispatchedAt: now,
    providerSessionId: input.providerSessionId === undefined ? existing.providerSessionId : input.providerSessionId,
    provider: input.provider ?? existing.provider ?? "minimax",
    timeoutStreak: 0,
    errorStreak: 0,
    lastFailureAt: null,
    lastFailureKind: null,
    lastRunId: input.runId ?? existing.lastRunId,
    lastDispatchId: input.dispatchId ?? existing.lastDispatchId,
    cooldownUntil: null
  });
}

export async function markRunnerTimeout(
  input: RunnerLifecycleBaseInput
): Promise<{ session: SessionRecord | null; escalated: boolean }> {
  const existing = await getSession(input.paths, input.project.projectId, input.sessionId);
  if (!existing) {
    return { session: null, escalated: false };
  }

  const threshold = getTimeoutEscalationThreshold();
  const timeoutStreak = (existing.timeoutStreak ?? 0) + 1;
  const escalated = timeoutStreak >= threshold;
  const now = new Date().toISOString();
  const cooldownMs = getTimeoutCooldownMs();
  const cooldownUntil = escalated || cooldownMs <= 0 ? null : new Date(Date.now() + cooldownMs).toISOString();

  const updated = await touchSession(input.paths, input.project.projectId, existing.sessionId, {
    status: escalated ? "dismissed" : "idle",
    currentTaskId: input.taskId ?? existing.currentTaskId ?? null,
    lastInboxMessageId: input.messageId ?? existing.lastInboxMessageId ?? null,
    lastDispatchedAt: now,
    providerSessionId: input.providerSessionId === undefined ? existing.providerSessionId : input.providerSessionId,
    provider: input.provider ?? existing.provider ?? "minimax",
    timeoutStreak,
    lastFailureAt: now,
    lastFailureKind: "timeout",
    lastRunId: input.runId ?? existing.lastRunId,
    lastDispatchId: input.dispatchId ?? existing.lastDispatchId,
    cooldownUntil
  });

  await appendEvent(input.paths, {
    projectId: input.project.projectId,
    eventType: escalated ? "RUNNER_TIMEOUT_ESCALATED" : "RUNNER_TIMEOUT_SOFT",
    source: "manager",
    sessionId: updated.sessionId,
    taskId: updated.currentTaskId,
    payload: {
      runId: input.runId ?? updated.lastRunId ?? null,
      dispatchId: input.dispatchId ?? updated.lastDispatchId ?? null,
      timeoutStreak,
      threshold,
      cooldownUntil: cooldownUntil ?? null
    }
  });

  return { session: updated, escalated };
}

export async function markRunnerFatalError(input: RunnerErrorInput): Promise<SessionRecord | null> {
  const existing = await getSession(input.paths, input.project.projectId, input.sessionId);
  if (!existing) {
    return null;
  }
  const now = new Date().toISOString();
  const errorStreak = (existing.errorStreak ?? 0) + 1;
  const updated = await touchSession(input.paths, input.project.projectId, existing.sessionId, {
    status: "dismissed",
    currentTaskId: input.taskId ?? existing.currentTaskId ?? null,
    lastInboxMessageId: input.messageId ?? existing.lastInboxMessageId ?? null,
    lastDispatchedAt: now,
    providerSessionId: input.providerSessionId === undefined ? existing.providerSessionId : input.providerSessionId,
    provider: input.provider ?? existing.provider ?? "minimax",
    errorStreak,
    lastFailureAt: now,
    lastFailureKind: "error",
    lastRunId: input.runId ?? existing.lastRunId,
    lastDispatchId: input.dispatchId ?? existing.lastDispatchId,
    cooldownUntil: null,
    agentPid: null
  });

  await appendEvent(input.paths, {
    projectId: input.project.projectId,
    eventType: "RUNNER_FATAL_ERROR_DISMISSED",
    source: "manager",
    sessionId: updated.sessionId,
    taskId: updated.currentTaskId,
    payload: {
      runId: input.runId ?? updated.lastRunId ?? null,
      dispatchId: input.dispatchId ?? updated.lastDispatchId ?? null,
      error: input.error
    }
  });
  return updated;
}
