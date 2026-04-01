import type { ProjectPaths, ProjectRecord, SessionRecord } from "../../domain/models.js";
import type { ProjectRepositoryBundle } from "../../data/repository/project-repository-bundle.js";
import { resolveActiveSessionForRole } from "../session-lifecycle-authority.js";
import { buildPendingSessionId, isForceDispatchableState } from "./project-dispatch-policy.js";
import type { DispatchProjectInput, ProjectDispatchResult } from "./project-orchestrator-types.js";

interface ProjectDispatchSessionHelperContext {
  dataRoot: string;
  repositories: ProjectRepositoryBundle;
}

export class ProjectDispatchSessionHelper {
  constructor(private readonly context: ProjectDispatchSessionHelperContext) {}

  async validateForceDispatchTask(
    project: ProjectRecord,
    paths: ProjectPaths,
    input: DispatchProjectInput
  ): Promise<ProjectDispatchResult["results"][number] | null> {
    if (!input.force || !input.taskId) {
      return null;
    }
    const allTasks = await this.context.repositories.taskboard.listTasks(paths, project.projectId);
    const targetTask = allTasks.find((item) => item.taskId === input.taskId);
    if (!targetTask) {
      return {
        sessionId: input.sessionId ?? "unknown",
        role: "unknown",
        outcome: "task_not_found",
        dispatchKind: "task",
        taskId: input.taskId,
        reason: `task '${input.taskId}' does not exist (hint: refresh task-tree and retry with current task_id)`
      };
    }
    if (!isForceDispatchableState(targetTask.state)) {
      return {
        sessionId: targetTask.ownerSession ?? input.sessionId ?? "unknown",
        role: targetTask.ownerRole,
        outcome: "task_not_force_dispatchable",
        dispatchKind: "task",
        taskId: input.taskId,
        reason: `task '${input.taskId}' state=${targetTask.state} is not force-dispatchable`
      };
    }
    return null;
  }

  async resolveDispatchSessions(
    project: ProjectRecord,
    paths: ProjectPaths,
    input: DispatchProjectInput,
    mode: "manual" | "loop"
  ): Promise<{
    orderedSessions: SessionRecord[];
    forceBootstrappedSessionId: string | null;
    preflightResult: ProjectDispatchResult["results"][number] | null;
  }> {
    const selectedSessions = await (input.sessionId
      ? this.context.repositories.sessions
          .getSession(paths, project.projectId, input.sessionId)
          .then((item) => (item ? [item] : []))
      : this.context.repositories.sessions.listSessions(paths, project.projectId));
    if (input.sessionId && selectedSessions.length === 0) {
      return {
        orderedSessions: [],
        forceBootstrappedSessionId: null,
        preflightResult: {
          sessionId: input.sessionId,
          role: "unknown",
          outcome: "session_not_found",
          dispatchKind: null
        }
      };
    }

    const forceBootstrappedSessionId = await this.bootstrapForceDispatchSession(project, paths, input);
    const effectiveSessions = await this.resolveEffectiveSessions(project, paths, input, selectedSessions);
    if (input.sessionId && effectiveSessions.length === 0) {
      return {
        orderedSessions: [],
        forceBootstrappedSessionId,
        preflightResult: {
          sessionId: input.sessionId,
          role: "unknown",
          outcome: "session_not_found",
          dispatchKind: null
        }
      };
    }

    const orderedSessions = await this.resolveOrderedSessions(project, paths, effectiveSessions, input, mode);
    if (input.sessionId && orderedSessions.length === 0 && effectiveSessions[0]) {
      return {
        orderedSessions: [],
        forceBootstrappedSessionId,
        preflightResult: {
          sessionId: effectiveSessions[0].sessionId,
          role: effectiveSessions[0].role,
          outcome: "session_busy",
          dispatchKind: null,
          reason: "session is not authoritative active session for role"
        }
      };
    }

    return {
      orderedSessions,
      forceBootstrappedSessionId,
      preflightResult: null
    };
  }

  async bootstrapForceDispatchSession(
    project: ProjectRecord,
    paths: ProjectPaths,
    input: DispatchProjectInput
  ): Promise<string | null> {
    let forceBootstrappedSessionId: string | null = null;
    if (!input.force || !input.taskId) {
      return forceBootstrappedSessionId;
    }
    const allTasks = await this.context.repositories.taskboard.listTasks(paths, project.projectId);
    const targetTask = allTasks.find((item) => item.taskId === input.taskId);
    if (!targetTask || !isForceDispatchableState(targetTask.state) || input.sessionId) {
      return forceBootstrappedSessionId;
    }
    const activeOwnerSession = await resolveActiveSessionForRole({
      dataRoot: this.context.dataRoot,
      project,
      paths,
      role: targetTask.ownerRole,
      reason: "force_dispatch_owner_resolution"
    });
    if (activeOwnerSession && activeOwnerSession.status !== "dismissed") {
      input.sessionId = activeOwnerSession.sessionId;
      return forceBootstrappedSessionId;
    }
    const newSessionId = buildPendingSessionId(targetTask.ownerRole);
    const ownerProviderId = project.agentModelConfigs?.[targetTask.ownerRole]?.provider_id ?? "minimax";
    await this.context.repositories.runInUnitOfWork({ project, paths }, async () => {
      const created = await this.context.repositories.sessions.addSession(paths, project.projectId, {
        sessionId: newSessionId,
        role: targetTask.ownerRole,
        status: "idle",
        providerSessionId: undefined,
        provider: ownerProviderId
      });
      await this.context.repositories.taskboard.patchTask(paths, project.projectId, targetTask.taskId, {
        ownerSession: created.session.sessionId
      });
      await this.context.repositories.projectRuntime.setRoleSessionMapping(
        project.projectId,
        targetTask.ownerRole,
        created.session.sessionId
      );
      await this.context.repositories.events.appendEvent(paths, {
        projectId: project.projectId,
        eventType: "SESSION_AUTO_BOOTSTRAPPED_FOR_FORCE_DISPATCH",
        source: "manager",
        sessionId: created.session.sessionId,
        taskId: targetTask.taskId,
        payload: {
          taskId: targetTask.taskId,
          ownerRole: targetTask.ownerRole,
          newSessionId: created.session.sessionId,
          reason: "no_active_owner_session"
        }
      });
      input.sessionId = created.session.sessionId;
      forceBootstrappedSessionId = created.session.sessionId;
    });
    return forceBootstrappedSessionId;
  }

  async resolveEffectiveSessions(
    project: ProjectRecord,
    paths: ProjectPaths,
    input: DispatchProjectInput,
    selectedSessions: SessionRecord[]
  ): Promise<SessionRecord[]> {
    const effectiveSelected = input.sessionId
      ? (() => {
          const target = selectedSessions.find((item) => item.sessionId === input.sessionId);
          return target ? [target] : [];
        })()
      : [...selectedSessions];
    if (input.sessionId && effectiveSelected.length === 0) {
      const target = await this.context.repositories.sessions.getSession(paths, project.projectId, input.sessionId);
      if (target) {
        effectiveSelected.push(target);
      }
    }
    return effectiveSelected;
  }

  async resolveOrderedSessions(
    project: ProjectRecord,
    paths: ProjectPaths,
    effectiveSelected: SessionRecord[],
    input: DispatchProjectInput,
    mode: "manual" | "loop"
  ): Promise<SessionRecord[]> {
    const rolesToResolve = Array.from(new Set(effectiveSelected.map((item) => item.role)));
    const activeSessionByRole = new Map<string, SessionRecord>();
    for (const role of rolesToResolve) {
      const active = await resolveActiveSessionForRole({
        dataRoot: this.context.dataRoot,
        project,
        paths,
        role,
        reason: "dispatch_project"
      });
      if (active) {
        activeSessionByRole.set(role, active);
      }
    }

    let orderedSessions =
      mode === "loop" && !input.sessionId
        ? [...activeSessionByRole.values()].sort((a, b) => {
            const aKey = Date.parse(a.lastDispatchedAt ?? a.lastActiveAt ?? a.createdAt);
            const bKey = Date.parse(b.lastDispatchedAt ?? b.lastActiveAt ?? b.createdAt);
            return aKey !== bKey ? aKey - bKey : a.sessionId.localeCompare(b.sessionId);
          })
        : [...activeSessionByRole.values()];

    if (input.sessionId) {
      const requestedSession = effectiveSelected[0];
      if (!requestedSession) {
        return [];
      }
      const activeForRole = activeSessionByRole.get(requestedSession.role);
      orderedSessions = activeForRole && activeForRole.sessionId === requestedSession.sessionId ? [activeForRole] : [];
    }
    return orderedSessions;
  }
}
