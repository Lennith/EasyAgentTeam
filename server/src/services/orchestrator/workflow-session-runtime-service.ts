import { resolveSessionProviderId, type ProviderRegistry } from "../provider-runtime.js";
import type { WorkflowRunRecord, WorkflowSessionRecord } from "../../domain/models.js";
import { parseIsoMs } from "./session-manager.js";
import type { WorkflowRepositoryBundle } from "../../data/repository/workflow-repository-bundle.js";
import { buildRoleScopedSessionId } from "./shared/orchestrator-identifiers.js";
import { resolveOrchestratorProviderSessionId } from "./shared/orchestrator-runtime-helpers.js";
import { markWorkflowTimedOutSessions } from "./workflow-session-runtime-timeout.js";

interface WorkflowSessionRuntimeContext {
  dataRoot: string;
  repositories: WorkflowRepositoryBundle;
  providerRegistry: ProviderRegistry;
  sessionRunningTimeoutMs: number;
  sessionHeartbeatThrottle: Map<string, number>;
  buildRunSessionKey(runId: string, sessionId: string): string;
}

export class WorkflowSessionRuntimeService {
  constructor(private readonly context: WorkflowSessionRuntimeContext) {}

  private async loadRunOrThrow(runId: string): Promise<WorkflowRunRecord> {
    const run = await this.context.repositories.workflowRuns.getRun(runId);
    if (!run) {
      throw new Error(`run '${runId}' not found`);
    }
    return run;
  }

  private async persistRoleSessionMap(
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
    await this.context.repositories.workflowRuns.patchRun(run.runId, { roleSessionMap: normalized ?? {} });
    run.roleSessionMap = normalized;
    return true;
  }

  async resolveAuthoritativeSession(
    runId: string,
    role: string,
    sessions: WorkflowSessionRecord[],
    runRecord?: WorkflowRunRecord,
    reason: string = "workflow_runtime"
  ): Promise<WorkflowSessionRecord | null> {
    const normalizedRole = role.trim();
    if (!normalizedRole) {
      return null;
    }
    const run = runRecord ?? (await this.loadRunOrThrow(runId));
    const roleSessions = [...sessions].filter((item) => item.role === normalizedRole && item.status !== "dismissed");
    const mappedSessionId = run.roleSessionMap?.[normalizedRole];
    if (roleSessions.length === 0) {
      if (mappedSessionId) {
        await this.persistRoleSessionMap(run, normalizedRole, null);
      }
      const created = await this.context.repositories.sessions.upsertSession(runId, {
        sessionId: buildRoleScopedSessionId(normalizedRole),
        role: normalizedRole,
        status: "idle",
        provider: "minimax"
      });
      sessions.push(created.session);
      await this.persistRoleSessionMap(run, normalizedRole, created.session.sessionId);
      return created.session;
    }

    const activeRunners = roleSessions
      .filter((item) => {
        if (item.status !== "running") {
          return false;
        }
        const providerSessionId = resolveOrchestratorProviderSessionId(item.sessionId, item.providerSessionId);
        return this.context.providerRegistry.isSessionActive(item.provider, providerSessionId);
      })
      .sort((a, b) => {
        const aRecent = Math.max(parseIsoMs(a.lastActiveAt), parseIsoMs(a.updatedAt), parseIsoMs(a.createdAt));
        const bRecent = Math.max(parseIsoMs(b.lastActiveAt), parseIsoMs(b.updatedAt), parseIsoMs(b.createdAt));
        if (aRecent !== bRecent) {
          return bRecent - aRecent;
        }
        return a.sessionId.localeCompare(b.sessionId);
      });
    const mapped =
      mappedSessionId && roleSessions.some((item) => item.sessionId === mappedSessionId)
        ? (roleSessions.find((item) => item.sessionId === mappedSessionId) ?? null)
        : null;
    const winner =
      activeRunners[0] ??
      mapped ??
      roleSessions.sort((a, b) => {
        const aRecent = Math.max(parseIsoMs(a.lastActiveAt), parseIsoMs(a.updatedAt), parseIsoMs(a.createdAt));
        const bRecent = Math.max(parseIsoMs(b.lastActiveAt), parseIsoMs(b.updatedAt), parseIsoMs(b.createdAt));
        if (aRecent !== bRecent) {
          return bRecent - aRecent;
        }
        return a.sessionId.localeCompare(b.sessionId);
      })[0];
    const losers = roleSessions.filter((item) => item.sessionId !== winner.sessionId);
    const mapUpdated = await this.persistRoleSessionMap(run, normalizedRole, winner.sessionId);

    if (losers.length > 0) {
      await this.context.repositories.events.appendEvent(runId, {
        eventType: "ROLE_SESSION_CONFLICT_DETECTED",
        source: "system",
        sessionId: winner.sessionId,
        payload: {
          role: normalizedRole,
          reason,
          winnerSessionId: winner.sessionId,
          loserSessionIds: losers.map((item) => item.sessionId)
        }
      });
      for (const loser of losers) {
        await this.context.repositories.sessions
          .touchSession(runId, loser.sessionId, {
            status: "dismissed",
            currentTaskId: null,
            agentPid: null
          })
          .catch(() => {});
        loser.status = "dismissed";
        await this.context.repositories.events.appendEvent(runId, {
          eventType: "DISPATCH_CLOSED_BY_CONFLICT",
          source: "system",
          sessionId: loser.sessionId,
          taskId: loser.currentTaskId,
          payload: {
            role: normalizedRole,
            winnerSessionId: winner.sessionId,
            loserSessionId: loser.sessionId,
            dispatchId: loser.lastDispatchId ?? null,
            runId
          }
        });
      }
    }
    if (losers.length > 0 || mapUpdated) {
      await this.context.repositories.events.appendEvent(runId, {
        eventType: "ROLE_SESSION_CONFLICT_RESOLVED",
        source: "system",
        sessionId: winner.sessionId,
        payload: {
          role: normalizedRole,
          reason,
          activeSessionId: winner.sessionId,
          dismissedSessionIds: losers.map((item) => item.sessionId),
          roleSessionMapUpdated: mapUpdated
        }
      });
    }
    return (await this.context.repositories.sessions.getSession(runId, winner.sessionId)) ?? winner;
  }

  async touchSessionHeartbeat(runId: string, sessionId: string): Promise<void> {
    const key = this.context.buildRunSessionKey(runId, sessionId);
    const nowMs = Date.now();
    const last = this.context.sessionHeartbeatThrottle.get(key) ?? 0;
    if (nowMs - last < 1000) {
      return;
    }
    this.context.sessionHeartbeatThrottle.set(key, nowMs);
    await this.context.repositories.sessions.touchSession(runId, sessionId, {}).catch(() => {});
  }

  async listRunSessions(runId: string): Promise<{ runId: string; items: WorkflowSessionRecord[] }> {
    await this.loadRunOrThrow(runId);
    return { runId, items: await this.context.repositories.sessions.listSessions(runId) };
  }

  async registerRunSession(
    runId: string,
    input: {
      role: string;
      sessionId?: string;
      status?: string;
      providerSessionId?: string;
      provider?: "codex" | "trae" | "minimax";
    }
  ): Promise<{ session: WorkflowSessionRecord; created: boolean }> {
    const run = await this.loadRunOrThrow(runId);
    const result = await this.context.repositories.sessions.upsertSession(runId, {
      sessionId: input.sessionId?.trim() || buildRoleScopedSessionId(input.role),
      role: input.role,
      status: input.status,
      provider: input.provider,
      providerSessionId: input.providerSessionId
    });
    if (result.session.status !== "dismissed") {
      await this.persistRoleSessionMap(run, input.role, result.session.sessionId);
    }
    return result;
  }

  async markTimedOutSessions(run: WorkflowRunRecord, sessions: WorkflowSessionRecord[]): Promise<void> {
    await markWorkflowTimedOutSessions(
      {
        dataRoot: this.context.dataRoot,
        repositories: this.context.repositories,
        providerRegistry: this.context.providerRegistry,
        sessionRunningTimeoutMs: this.context.sessionRunningTimeoutMs,
        resolveAuthoritativeSession: (runId, role, candidateSessions, runRecord, reason) =>
          this.resolveAuthoritativeSession(runId, role, candidateSessions, runRecord, reason)
      },
      run,
      sessions
    );
  }
}
