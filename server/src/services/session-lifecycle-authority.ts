import { appendEvent } from "../data/repository/project/event-repository.js";
import { clearRoleSessionMapping, setRoleSessionMapping } from "../data/repository/project/runtime-repository.js";
import { getSession, listSessions, touchSession } from "../data/repository/project/session-repository.js";
import type { ProviderId } from "@autodev/agent-library";
import type { ProjectPaths, ProjectRecord, SessionRecord } from "../domain/models.js";
import { isMiniMaxRunnerActive } from "./minimax-runner.js";
import {
  resolveRunnerFailureTransition,
  type RunnerFailureTransitionResult
} from "./orchestrator/shared/runner-failure-transition.js";

const DEFAULT_TIMEOUT_ESCALATION_THRESHOLD = 3;
const DEFAULT_TIMEOUT_COOLDOWN_MS = 0;
const DEFAULT_TRANSIENT_ERROR_COOLDOWN_MS = 30000;

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
  code?: string;
  nextAction?: string;
  rawStatus?: number | string | null;
}

type RunnerTransientErrorInput = RunnerErrorInput;

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

export function getTransientErrorCooldownMs(): number {
  const raw = Number(process.env.SESSION_TRANSIENT_ERROR_COOLDOWN_MS ?? DEFAULT_TRANSIENT_ERROR_COOLDOWN_MS);
  if (!Number.isFinite(raw) || raw < 0) {
    return DEFAULT_TRANSIENT_ERROR_COOLDOWN_MS;
  }
  return Math.floor(raw);
}

function resolveDispatchKind(messageId: string | undefined): "task" | "message" {
  return messageId ? "message" : "task";
}

function buildClearedFailureContextPatch() {
  return {
    lastFailureAt: null,
    lastFailureKind: null,
    lastFailureEventId: null,
    lastFailureDispatchId: null,
    lastFailureMessageId: null,
    lastFailureTaskId: null
  } as const;
}

async function applyRunnerFailureTransition(
  input: RunnerLifecycleBaseInput,
  existing: SessionRecord,
  transition: RunnerFailureTransitionResult
): Promise<SessionRecord | null> {
  const failedTaskId =
    transition.session_patch.currentTaskId === undefined
      ? (input.taskId ?? existing.currentTaskId ?? null)
      : transition.session_patch.currentTaskId;
  const updated = await touchSession(input.paths, input.project.projectId, existing.sessionId, {
    status: transition.session_patch.status,
    currentTaskId: failedTaskId,
    lastInboxMessageId: input.messageId ?? existing.lastInboxMessageId ?? null,
    lastDispatchedAt: transition.session_patch.lastFailureAt,
    providerSessionId: input.providerSessionId === undefined ? existing.providerSessionId : input.providerSessionId,
    provider: input.provider ?? existing.provider ?? "minimax",
    errorStreak: transition.session_patch.errorStreak,
    timeoutStreak: transition.session_patch.timeoutStreak,
    lastFailureAt: transition.session_patch.lastFailureAt,
    lastFailureKind: transition.session_patch.lastFailureKind,
    lastFailureDispatchId: input.dispatchId ?? existing.lastDispatchId ?? null,
    lastFailureMessageId: input.messageId ?? existing.lastInboxMessageId ?? null,
    lastFailureTaskId: failedTaskId,
    lastRunId: input.runId ?? existing.lastRunId,
    lastDispatchId: input.dispatchId ?? existing.lastDispatchId,
    cooldownUntil: transition.session_patch.cooldownUntil,
    agentPid: null
  });

  const failureEvent = await appendEvent(input.paths, {
    projectId: input.project.projectId,
    eventType: transition.event_type,
    source: "manager",
    sessionId: updated.sessionId,
    taskId: updated.currentTaskId,
    payload: transition.event_payload
  });
  return await touchSession(input.paths, input.project.projectId, updated.sessionId, {
    lastFailureEventId: failureEvent.eventId
  });
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
    cooldownUntil: null,
    ...buildClearedFailureContextPatch()
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
    ...buildClearedFailureContextPatch(),
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
  const transition = resolveRunnerFailureTransition({
    kind: "timeout",
    run_id: input.runId ?? existing.lastRunId ?? null,
    dispatch_id: input.dispatchId ?? existing.lastDispatchId ?? null,
    dispatch_kind: resolveDispatchKind(input.messageId),
    message_id: input.messageId ?? existing.lastInboxMessageId ?? null,
    current_task_id: input.taskId ?? existing.currentTaskId ?? null,
    preserve_current_task_id: true,
    existing_timeout_streak: existing.timeoutStreak ?? 0,
    timeout_threshold: threshold,
    timeout_cooldown_ms: getTimeoutCooldownMs()
  });
  const updated = await applyRunnerFailureTransition(input, existing, transition);
  return { session: updated, escalated: transition.escalated };
}

export async function markRunnerFatalError(input: RunnerErrorInput): Promise<SessionRecord | null> {
  const existing = await getSession(input.paths, input.project.projectId, input.sessionId);
  if (!existing) {
    return null;
  }
  const transition = resolveRunnerFailureTransition({
    kind: "generic",
    run_id: input.runId ?? existing.lastRunId ?? null,
    dispatch_id: input.dispatchId ?? existing.lastDispatchId ?? null,
    dispatch_kind: resolveDispatchKind(input.messageId),
    message_id: input.messageId ?? existing.lastInboxMessageId ?? null,
    error: input.error,
    code: input.code ?? null,
    next_action: input.nextAction ?? null,
    raw_status: input.rawStatus ?? null,
    current_task_id: input.taskId ?? existing.currentTaskId ?? null,
    preserve_current_task_id: true,
    existing_error_streak: existing.errorStreak ?? 0,
    generic_runtime_strategy: {
      session_status: "dismissed",
      event_type: "RUNNER_FATAL_ERROR_DISMISSED",
      retryable: false
    }
  });
  return applyRunnerFailureTransition(input, existing, transition);
}

export async function markRunnerRetryableError(input: RunnerErrorInput): Promise<SessionRecord | null> {
  const existing = await getSession(input.paths, input.project.projectId, input.sessionId);
  if (!existing) {
    return null;
  }
  const transition = resolveRunnerFailureTransition({
    kind: "generic",
    run_id: input.runId ?? existing.lastRunId ?? null,
    dispatch_id: input.dispatchId ?? existing.lastDispatchId ?? null,
    dispatch_kind: resolveDispatchKind(input.messageId),
    message_id: input.messageId ?? existing.lastInboxMessageId ?? null,
    error: input.error,
    code: input.code ?? null,
    next_action: input.nextAction ?? null,
    raw_status: input.rawStatus ?? null,
    current_task_id: input.taskId ?? existing.currentTaskId ?? null,
    preserve_current_task_id: true,
    existing_error_streak: existing.errorStreak ?? 0,
    generic_runtime_strategy: {
      session_status: "idle",
      event_type: "RUNNER_RUNTIME_ERROR_SOFT",
      retryable: true
    }
  });
  return applyRunnerFailureTransition(input, existing, transition);
}

export async function markRunnerTransientError(input: RunnerTransientErrorInput): Promise<SessionRecord | null> {
  const existing = await getSession(input.paths, input.project.projectId, input.sessionId);
  if (!existing) {
    return null;
  }
  const transition = resolveRunnerFailureTransition({
    kind: "transient",
    run_id: input.runId ?? existing.lastRunId ?? null,
    dispatch_id: input.dispatchId ?? existing.lastDispatchId ?? null,
    dispatch_kind: resolveDispatchKind(input.messageId),
    message_id: input.messageId ?? existing.lastInboxMessageId ?? null,
    error: input.error,
    code: input.code ?? null,
    next_action: input.nextAction ?? null,
    raw_status: input.rawStatus ?? null,
    current_task_id: input.taskId ?? existing.currentTaskId ?? null,
    preserve_current_task_id: true,
    existing_error_streak: existing.errorStreak ?? 0,
    transient_cooldown_ms: getTransientErrorCooldownMs()
  });
  return applyRunnerFailureTransition(input, existing, transition);
}

export async function markRunnerBlocked(input: RunnerErrorInput): Promise<SessionRecord | null> {
  const existing = await getSession(input.paths, input.project.projectId, input.sessionId);
  if (!existing) {
    return null;
  }
  const transition = resolveRunnerFailureTransition({
    kind: "config",
    run_id: input.runId ?? existing.lastRunId ?? null,
    dispatch_id: input.dispatchId ?? existing.lastDispatchId ?? null,
    dispatch_kind: resolveDispatchKind(input.messageId),
    message_id: input.messageId ?? existing.lastInboxMessageId ?? null,
    error: input.error,
    code: input.code ?? null,
    next_action: input.nextAction ?? null,
    raw_status: input.rawStatus ?? null,
    current_task_id: input.taskId ?? existing.currentTaskId ?? null,
    preserve_current_task_id: true,
    existing_error_streak: existing.errorStreak ?? 0
  });
  return applyRunnerFailureTransition(input, existing, transition);
}
