import type { ProjectPaths, ProjectRecord, SessionRecord } from "../../../domain/models.js";
import { markProjectTimedOutSessions } from "./project-session-runtime-timeout.js";
import {
  terminateProjectSessionProcessInternal,
  type SessionProcessTerminationResult,
  type SessionProcessTerminationResultCode
} from "./project-session-runtime-termination.js";
import type { ProjectSessionRuntimeContext } from "./project-orchestrator-types.js";

export {
  findLatestDispatchStarted,
  findLatestDispatchStartedById,
  findLatestOpenRun,
  hasDispatchClosedEvent,
  readPidFromEventPayload,
  terminateProcessByPid
} from "./project-session-runtime-termination.js";
export type { SessionProcessTerminationResult, SessionProcessTerminationResultCode };

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
    targetStatus: "idle" | "blocked"
  ): Promise<SessionRecord> {
    const scope = await this.context.repositories.resolveScope(projectId);
    const { project, paths } = scope;
    const session = await this.context.repositories.sessions.getSession(paths, project.projectId, sessionId);
    if (!session) {
      throw new Error(`session '${sessionId}' not found`);
    }
    return this.context.repositories.runInUnitOfWork(scope, async () => {
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
        source: "dashboard",
        sessionId,
        taskId: updated.currentTaskId,
        payload: {
          previous_status: session.status,
          target_status: targetStatus
        }
      });
      return updated;
    });
  }

  async dismissSession(
    projectId: string,
    sessionId: string,
    reason: string
  ): Promise<{
    session: SessionRecord;
    mappingCleared: boolean;
    processTermination: SessionProcessTerminationResult;
  }> {
    const scope = await this.context.repositories.resolveScope(projectId);
    const { project, paths } = scope;
    const session = await this.context.repositories.sessions.getSession(paths, project.projectId, sessionId);
    if (!session) {
      throw new Error(`session '${sessionId}' not found`);
    }
    return this.context.repositories.runInUnitOfWork(scope, async () => {
      const processTermination = await this.terminateSessionProcessInternal(project, paths, session, reason);
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
        source: "dashboard",
        sessionId: dismissed.sessionId,
        taskId: session.currentTaskId,
        payload: {
          previous_status: session.status,
          reason,
          mapping_cleared: mappingCleared,
          process_result: processTermination.result
        }
      });
      return {
        session: dismissed,
        mappingCleared,
        processTermination
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
