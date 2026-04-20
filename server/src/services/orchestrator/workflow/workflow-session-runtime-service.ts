import type { ProviderRegistry } from "../../provider-runtime.js";
import type { WorkflowRunRecord, WorkflowSessionRecord } from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import { markWorkflowTimedOutSessions } from "./workflow-session-runtime-timeout.js";
import { resolveSessionProviderId } from "../../provider-runtime.js";
import { resolveOrchestratorProviderSessionId } from "../shared/index.js";
import type {
  RecoveryDismissResult,
  RecoveryProcessTerminationView,
  RecoveryProviderCancelResult,
  RecoveryRepairResult
} from "../../runtime-recovery-action-policy.js";
import {
  buildDismissExternalStopUnconfirmed,
  hasConfirmedDismissExternalStop
} from "../../runtime-recovery-action-policy.js";
import { RecoveryCommandError } from "../../runtime-recovery-command-error.js";
import {
  loadWorkflowRunOrThrow,
  registerWorkflowRunSession,
  resolveWorkflowAuthoritativeSession,
  type WorkflowSessionAuthorityContext,
  type WorkflowSessionRegistrationInput
} from "./workflow-session-authority.js";

interface WorkflowSessionRuntimeContext extends WorkflowSessionAuthorityContext {
  dataRoot: string;
  sessionRunningTimeoutMs: number;
  sessionHeartbeatThrottle: Map<string, number>;
  buildRunSessionKey(runId: string, sessionId: string): string;
}

function resolveRecoveryAuditSource(actor: "dashboard" | "api"): "dashboard" | "system" {
  return actor === "dashboard" ? "dashboard" : "system";
}

export class WorkflowSessionRuntimeService {
  constructor(private readonly context: WorkflowSessionRuntimeContext) {}

  private buildWorkflowProviderCancelResult(cancelled: boolean): RecoveryProviderCancelResult {
    return {
      attempted: true,
      confirmed: cancelled,
      result: cancelled ? "cancelled" : "unknown",
      error: cancelled ? null : "Provider did not confirm session cancellation."
    };
  }

  private buildWorkflowProcessTerminationView(): RecoveryProcessTerminationView | null {
    return null;
  }

  private buildRepairWarnings(session: WorkflowSessionRecord): string[] {
    return session.currentTaskId
      ? [`Current task '${session.currentTaskId}' remains attached to this session after repair.`]
      : [];
  }

  private async loadRunOrThrow(runId: string): Promise<WorkflowRunRecord> {
    return await loadWorkflowRunOrThrow(this.context.repositories, runId);
  }

  async resolveAuthoritativeSession(
    runId: string,
    role: string,
    sessions: WorkflowSessionRecord[],
    runRecord?: WorkflowRunRecord,
    reason: string = "workflow_runtime"
  ): Promise<WorkflowSessionRecord | null> {
    return await resolveWorkflowAuthoritativeSession(this.context, {
      runId,
      role,
      sessions,
      runRecord,
      reason
    });
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
    input: WorkflowSessionRegistrationInput
  ): Promise<{ session: WorkflowSessionRecord; created: boolean }> {
    return await registerWorkflowRunSession(this.context, runId, input);
  }

  async dismissSession(
    runId: string,
    sessionId: string,
    reason: string,
    actor: "dashboard" | "api" = "dashboard"
  ): Promise<RecoveryDismissResult<WorkflowSessionRecord>> {
    const scope = await this.context.repositories.resolveScope(runId);
    const { run } = scope;
    const session = await this.context.repositories.sessions.getSession(run.runId, sessionId);
    if (!session) {
      throw new Error(`session '${sessionId}' not found`);
    }
    const providerId = session.provider ?? resolveSessionProviderId(run, session.role, "minimax");
    const cancelSessionId = resolveOrchestratorProviderSessionId(session.sessionId, session.providerSessionId);
    const cancelled = this.context.providerRegistry.cancelSession(providerId, cancelSessionId);
    const providerCancel = this.buildWorkflowProviderCancelResult(cancelled);
    const processTermination = this.buildWorkflowProcessTerminationView();
    const warnings = cancelled
      ? []
      : ["Provider cancellation was not confirmed; inspect the provider runtime before retrying."];
    await this.context.repositories.events.appendEvent(run.runId, {
      eventType: "SESSION_DISMISS_EXTERNAL_RESULT",
      source: resolveRecoveryAuditSource(actor),
      sessionId: session.sessionId,
      taskId: session.currentTaskId,
      payload: {
        previous_status: session.status,
        reason,
        actor,
        provider_cancel: providerCancel,
        process_termination: processTermination,
        warnings
      }
    });
    if (!hasConfirmedDismissExternalStop(providerCancel, processTermination)) {
      throw new RecoveryCommandError(
        409,
        buildDismissExternalStopUnconfirmed(
          session.sessionId,
          session.status,
          providerCancel,
          processTermination,
          warnings
        )
      );
    }
    return this.context.repositories.runInUnitOfWork(scope, async () => {
      const dismissed = await this.context.repositories.sessions.touchSession(run.runId, session.sessionId, {
        status: "dismissed",
        currentTaskId: null,
        agentPid: null,
        cooldownUntil: null
      });
      let mappingCleared = false;
      if (run.roleSessionMap?.[session.role] === session.sessionId) {
        const nextMap = { ...(run.roleSessionMap ?? {}) };
        delete nextMap[session.role];
        await this.context.repositories.workflowRuns.patchRun(run.runId, {
          roleSessionMap: Object.keys(nextMap).length > 0 ? nextMap : undefined
        });
        mappingCleared = true;
      }
      await this.context.repositories.events.appendEvent(run.runId, {
        eventType: "SESSION_STATUS_DISMISSED",
        source: resolveRecoveryAuditSource(actor),
        sessionId: dismissed.sessionId,
        taskId: session.currentTaskId,
        payload: {
          previous_status: session.status,
          reason,
          actor,
          provider_cancel: providerCancel,
          process_termination: processTermination,
          mapping_cleared: mappingCleared,
          warnings
        }
      });
      return {
        action: "dismiss",
        session: dismissed,
        previous_status: session.status,
        next_status: "dismissed",
        provider_cancel: providerCancel,
        process_termination: processTermination,
        mapping_cleared: mappingCleared,
        warnings
      };
    });
  }

  async repairSessionStatus(
    runId: string,
    sessionId: string,
    targetStatus: "idle" | "blocked",
    reason: string,
    actor: "dashboard" | "api" = "dashboard"
  ): Promise<RecoveryRepairResult<WorkflowSessionRecord>> {
    const scope = await this.context.repositories.resolveScope(runId);
    const { run } = scope;
    const session = await this.context.repositories.sessions.getSession(run.runId, sessionId);
    if (!session) {
      throw new Error(`session '${sessionId}' not found`);
    }
    return this.context.repositories.runInUnitOfWork(scope, async () => {
      const warnings = this.buildRepairWarnings(session);
      const repaired = await this.context.repositories.sessions.touchSession(run.runId, session.sessionId, {
        status: targetStatus,
        agentPid: null,
        cooldownUntil: null,
        lastFailureAt: null,
        lastFailureKind: null,
        errorStreak: null,
        timeoutStreak: null
      });
      await this.context.repositories.events.appendEvent(run.runId, {
        eventType: "SESSION_STATUS_REPAIRED",
        source: resolveRecoveryAuditSource(actor),
        sessionId: repaired.sessionId,
        taskId: repaired.currentTaskId,
        payload: {
          previous_status: session.status,
          target_status: targetStatus,
          previous_current_task_id: session.currentTaskId ?? null,
          previous_failure_kind: session.lastFailureKind ?? null,
          previous_last_failure_at: session.lastFailureAt ?? null,
          previous_error_streak: session.errorStreak ?? 0,
          previous_timeout_streak: session.timeoutStreak ?? 0,
          previous_cooldown_until: session.cooldownUntil ?? null,
          previous_provider_session_id: session.providerSessionId ?? null,
          reason,
          actor,
          warnings
        }
      });
      return {
        action: "repair",
        session: repaired,
        previous_status: session.status,
        next_status: targetStatus,
        warnings
      };
    });
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
