import type { ProjectPaths, ProjectRecord, SessionRecord } from "../../domain/models.js";
import type { ProjectRepositoryBundle } from "../../data/repository/project-repository-bundle.js";
import { resolveActiveSessionForRole } from "../session-lifecycle-authority.js";
import { buildPendingSessionId, isForceDispatchableState } from "./project-dispatch-policy.js";
import type { DispatchProjectInput } from "./project-orchestrator-types.js";

interface ProjectDispatchSessionHelperContext {
  dataRoot: string;
  repositories: ProjectRepositoryBundle;
}

export class ProjectDispatchSessionHelper {
  constructor(private readonly context: ProjectDispatchSessionHelperContext) {}

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
