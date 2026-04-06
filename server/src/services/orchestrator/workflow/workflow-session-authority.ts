import type { ProviderRegistry } from "../../provider-runtime.js";
import type { WorkflowRunRecord, WorkflowSessionRecord } from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import { parseIsoMs } from "../shared/session-manager.js";
import { buildRoleScopedSessionId } from "../shared/orchestrator-identifiers.js";
import { resolveOrchestratorProviderSessionId } from "../shared/orchestrator-runtime-helpers.js";

export interface WorkflowSessionAuthorityContext {
  repositories: WorkflowRepositoryBundle;
  providerRegistry: ProviderRegistry;
}

export interface WorkflowSessionRegistrationInput {
  role: string;
  sessionId?: string;
  status?: string;
  providerSessionId?: string;
  provider?: "codex" | "trae" | "minimax";
}

function sortSessionsByRecentActivity(a: WorkflowSessionRecord, b: WorkflowSessionRecord): number {
  const aRecent = Math.max(parseIsoMs(a.lastActiveAt), parseIsoMs(a.updatedAt), parseIsoMs(a.createdAt));
  const bRecent = Math.max(parseIsoMs(b.lastActiveAt), parseIsoMs(b.updatedAt), parseIsoMs(b.createdAt));
  if (aRecent !== bRecent) {
    return bRecent - aRecent;
  }
  return a.sessionId.localeCompare(b.sessionId);
}

export async function loadWorkflowRunOrThrow(
  repositories: Pick<WorkflowRepositoryBundle, "workflowRuns">,
  runId: string
): Promise<WorkflowRunRecord> {
  const run = await repositories.workflowRuns.getRun(runId);
  if (!run) {
    throw new Error(`run '${runId}' not found`);
  }
  return run;
}

export async function persistWorkflowRoleSessionMap(
  repositories: Pick<WorkflowRepositoryBundle, "workflowRuns">,
  run: WorkflowRunRecord,
  role: string,
  sessionId: string | null
): Promise<boolean> {
  const normalizedRole = role.trim();
  if (!normalizedRole) {
    return false;
  }
  const current = run.roleSessionMap?.[normalizedRole];
  if ((sessionId ?? undefined) === current) {
    return false;
  }
  const nextMap = { ...(run.roleSessionMap ?? {}) };
  if (sessionId) {
    nextMap[normalizedRole] = sessionId;
  } else {
    delete nextMap[normalizedRole];
  }
  const normalized = Object.keys(nextMap).length > 0 ? nextMap : undefined;
  await repositories.workflowRuns.patchRun(run.runId, { roleSessionMap: normalized ?? {} });
  run.roleSessionMap = normalized;
  return true;
}

export async function resolveWorkflowAuthoritativeSession(
  context: WorkflowSessionAuthorityContext,
  input: {
    runId: string;
    role: string;
    sessions: WorkflowSessionRecord[];
    runRecord?: WorkflowRunRecord;
    reason?: string;
  }
): Promise<WorkflowSessionRecord | null> {
  const normalizedRole = input.role.trim();
  if (!normalizedRole) {
    return null;
  }
  const run = input.runRecord ?? (await loadWorkflowRunOrThrow(context.repositories, input.runId));
  const roleSessions = [...input.sessions].filter(
    (item) => item.role === normalizedRole && item.status !== "dismissed"
  );
  const mappedSessionId = run.roleSessionMap?.[normalizedRole];
  if (roleSessions.length === 0) {
    if (mappedSessionId) {
      await persistWorkflowRoleSessionMap(context.repositories, run, normalizedRole, null);
    }
    const created = await context.repositories.sessions.upsertSession(input.runId, {
      sessionId: buildRoleScopedSessionId(normalizedRole),
      role: normalizedRole,
      status: "idle",
      provider: "minimax"
    });
    input.sessions.push(created.session);
    await persistWorkflowRoleSessionMap(context.repositories, run, normalizedRole, created.session.sessionId);
    return created.session;
  }

  const activeRunners = roleSessions
    .filter((item) => {
      if (item.status !== "running") {
        return false;
      }
      const providerSessionId = resolveOrchestratorProviderSessionId(item.sessionId, item.providerSessionId);
      return context.providerRegistry.isSessionActive(item.provider, providerSessionId);
    })
    .sort(sortSessionsByRecentActivity);
  const mapped =
    mappedSessionId && roleSessions.some((item) => item.sessionId === mappedSessionId)
      ? (roleSessions.find((item) => item.sessionId === mappedSessionId) ?? null)
      : null;
  const winner = activeRunners[0] ?? mapped ?? roleSessions.sort(sortSessionsByRecentActivity)[0];
  const losers = roleSessions.filter((item) => item.sessionId !== winner.sessionId);
  const mapUpdated = await persistWorkflowRoleSessionMap(context.repositories, run, normalizedRole, winner.sessionId);

  if (losers.length > 0) {
    await context.repositories.events.appendEvent(input.runId, {
      eventType: "ROLE_SESSION_CONFLICT_DETECTED",
      source: "system",
      sessionId: winner.sessionId,
      payload: {
        role: normalizedRole,
        reason: input.reason ?? "workflow_runtime",
        winnerSessionId: winner.sessionId,
        loserSessionIds: losers.map((item) => item.sessionId)
      }
    });
    for (const loser of losers) {
      await context.repositories.sessions
        .touchSession(input.runId, loser.sessionId, {
          status: "dismissed",
          currentTaskId: null,
          agentPid: null
        })
        .catch(() => {});
      loser.status = "dismissed";
      await context.repositories.events.appendEvent(input.runId, {
        eventType: "DISPATCH_CLOSED_BY_CONFLICT",
        source: "system",
        sessionId: loser.sessionId,
        taskId: loser.currentTaskId,
        payload: {
          role: normalizedRole,
          winnerSessionId: winner.sessionId,
          loserSessionId: loser.sessionId,
          dispatchId: loser.lastDispatchId ?? null,
          runId: input.runId
        }
      });
    }
  }
  if (losers.length > 0 || mapUpdated) {
    await context.repositories.events.appendEvent(input.runId, {
      eventType: "ROLE_SESSION_CONFLICT_RESOLVED",
      source: "system",
      sessionId: winner.sessionId,
      payload: {
        role: normalizedRole,
        reason: input.reason ?? "workflow_runtime",
        activeSessionId: winner.sessionId,
        dismissedSessionIds: losers.map((item) => item.sessionId),
        roleSessionMapUpdated: mapUpdated
      }
    });
  }
  return (await context.repositories.sessions.getSession(input.runId, winner.sessionId)) ?? winner;
}

export async function registerWorkflowRunSession(
  context: WorkflowSessionAuthorityContext,
  runId: string,
  input: WorkflowSessionRegistrationInput
): Promise<{ session: WorkflowSessionRecord; created: boolean }> {
  const run = await loadWorkflowRunOrThrow(context.repositories, runId);
  const result = await context.repositories.sessions.upsertSession(runId, {
    sessionId: input.sessionId?.trim() || buildRoleScopedSessionId(input.role),
    role: input.role,
    status: input.status,
    provider: input.provider,
    providerSessionId: input.providerSessionId
  });
  if (result.session.status !== "dismissed") {
    await persistWorkflowRoleSessionMap(context.repositories, run, input.role, result.session.sessionId);
  }
  return result;
}
