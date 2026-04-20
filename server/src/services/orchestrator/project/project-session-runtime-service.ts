import type { ProjectPaths, ProjectRecord, SessionRecord } from "../../../domain/models.js";
import { markProjectTimedOutSessions } from "./project-session-runtime-timeout.js";
import {
  terminateProjectSessionProcessInternal,
  type SessionProcessTerminationResult,
  type SessionProcessTerminationResultCode
} from "./project-session-runtime-termination.js";
import type { ProjectSessionRuntimeContext } from "./project-orchestrator-types.js";
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

export {
  findLatestDispatchStarted,
  findLatestDispatchStartedById,
  findLatestOpenRun,
  hasDispatchClosedEvent,
  readPidFromEventPayload,
  terminateProcessByPid
} from "./project-session-runtime-termination.js";
export type { SessionProcessTerminationResult, SessionProcessTerminationResultCode };

function buildProjectProviderCancelResult(): RecoveryProviderCancelResult {
  return {
    attempted: false,
    confirmed: false,
    result: "not_supported",
    error: null
  };
}

function buildProcessTerminationView(result: SessionProcessTerminationResult): RecoveryProcessTerminationView {
  return {
    attempted: result.attempted,
    result: result.result,
    message: result.message
  };
}

function buildRepairWarnings(session: SessionRecord): string[] {
  return session.currentTaskId
    ? [`Current task '${session.currentTaskId}' remains attached to this session after repair.`]
    : [];
}

function resolveRecoveryAuditSource(actor: "dashboard" | "api"): "dashboard" | "system" {
  return actor === "dashboard" ? "dashboard" : "system";
}

export class ProjectSessionRuntimeService {
  constructor(private readonly context: ProjectSessionRuntimeContext) {}

  async terminateSessionProcess(
    projectId: string,
    sessionId: string,
    reason: string
  ): Promise<SessionProcessTerminationResult> {
    const scope = await this.context.repositories.resolveScope(projectId);
    const { project, paths } = scope;
    const session = await this.context.repositories.sessions.getSession(paths, project.projectId, sessionId);
    if (!session) {
      return {
        attempted: false,
        pid: null,
        result: "not_found",
        message: `session '${sessionId}' not found`
      };
    }
    return this.terminateSessionProcessInternal(project, paths, session, reason);
  }

  async repairSessionStatus(
    projectId: string,
    sessionId: string,
    targetStatus: "idle" | "blocked",
    reason: string,
    actor: "dashboard" | "api" = "dashboard"
  ): Promise<RecoveryRepairResult<SessionRecord>> {
    const scope = await this.context.repositories.resolveScope(projectId);
    const { project, paths } = scope;
    const session = await this.context.repositories.sessions.getSession(paths, project.projectId, sessionId);
    if (!session) {
      throw new Error(`session '${sessionId}' not found`);
    }
    return this.context.repositories.runInUnitOfWork(scope, async () => {
      const warnings = buildRepairWarnings(session);
      const updated = await this.context.repositories.sessions.touchSession(paths, project.projectId, sessionId, {
        status: targetStatus,
        agentPid: null,
        cooldownUntil: null,
        lastFailureAt: null,
        lastFailureKind: null,
        errorStreak: null,
        timeoutStreak: null
      });
      await this.context.repositories.events.appendEvent(paths, {
        projectId: project.projectId,
        eventType: "SESSION_STATUS_REPAIRED",
        source: resolveRecoveryAuditSource(actor),
        sessionId,
        taskId: updated.currentTaskId,
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
        session: updated,
        previous_status: session.status,
        next_status: targetStatus,
        warnings
      };
    });
  }

  async dismissSession(
    projectId: string,
    sessionId: string,
    reason: string,
    actor: "dashboard" | "api" = "dashboard"
  ): Promise<RecoveryDismissResult<SessionRecord>> {
    const scope = await this.context.repositories.resolveScope(projectId);
    const { project, paths } = scope;
    const session = await this.context.repositories.sessions.getSession(paths, project.projectId, sessionId);
    if (!session) {
      throw new Error(`session '${sessionId}' not found`);
    }
    const providerCancel = buildProjectProviderCancelResult();
    const processTermination = await this.terminateSessionProcessInternal(project, paths, session, reason);
    const processTerminationView = buildProcessTerminationView(processTermination);
    const warnings =
      processTermination.result === "killed" || processTermination.result === "not_found"
        ? []
        : [processTermination.message];
    await this.context.repositories.events.appendEvent(paths, {
      projectId: project.projectId,
      eventType: "SESSION_DISMISS_EXTERNAL_RESULT",
      source: resolveRecoveryAuditSource(actor),
      sessionId: session.sessionId,
      taskId: session.currentTaskId,
      payload: {
        previous_status: session.status,
        reason,
        actor,
        provider_cancel: providerCancel,
        process_termination: processTerminationView,
        warnings
      }
    });
    if (!hasConfirmedDismissExternalStop(providerCancel, processTerminationView)) {
      throw new RecoveryCommandError(
        409,
        buildDismissExternalStopUnconfirmed(
          session.sessionId,
          session.status,
          providerCancel,
          processTerminationView,
          warnings
        )
      );
    }
    return this.context.repositories.runInUnitOfWork(scope, async () => {
      const dismissed = await this.context.repositories.sessions.touchSession(paths, project.projectId, sessionId, {
        status: "dismissed",
        currentTaskId: null,
        lastInboxMessageId: null,
        agentPid: null,
        cooldownUntil: null
      });
      let mappingCleared = false;
      if (project.roleSessionMap?.[session.role] === session.sessionId) {
        await this.context.repositories.projectRuntime.clearRoleSessionMapping(project.projectId, session.role);
        mappingCleared = true;
      }
      await this.context.repositories.events.appendEvent(paths, {
        projectId: project.projectId,
        eventType: "SESSION_STATUS_DISMISSED",
        source: resolveRecoveryAuditSource(actor),
        sessionId: dismissed.sessionId,
        taskId: session.currentTaskId,
        payload: {
          previous_status: session.status,
          reason,
          actor,
          provider_cancel: providerCancel,
          process_termination: processTerminationView,
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
        process_termination: processTerminationView,
        mapping_cleared: mappingCleared,
        warnings
      };
    });
  }

  async markTimedOutSessions(project: ProjectRecord, paths: ProjectPaths): Promise<void> {
    await markProjectTimedOutSessions(
      {
        dataRoot: this.context.dataRoot,
        repositories: this.context.repositories,
        sessionRunningTimeoutMs: this.context.sessionRunningTimeoutMs,
        terminateSessionProcess: async (targetProject, targetPaths, targetSession, reason) =>
          this.terminateSessionProcessInternal(targetProject, targetPaths, targetSession, reason)
      },
      project,
      paths
    );
  }

  private async terminateSessionProcessInternal(
    project: ProjectRecord,
    paths: ProjectPaths,
    session: SessionRecord,
    reason: string
  ): Promise<SessionProcessTerminationResult> {
    return terminateProjectSessionProcessInternal(this.context.repositories, project, paths, session, reason);
  }
}
