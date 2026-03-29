import { listAgents } from "../../data/agent-store.js";
import type { ProjectDispatchLoopState } from "./project-dispatch-loop-pipeline.js";
import type {
  DispatchProjectInput,
  ProjectDispatchContext,
  ProjectDispatchResult
} from "./project-orchestrator-types.js";
import { isForceDispatchableState } from "./project-dispatch-policy.js";
import { ProjectDispatchSelectionAdapter } from "./project-dispatch-selection-adapter.js";
import { ProjectDispatchLaunchAdapter } from "./project-dispatch-launch-adapter.js";
import { ProjectDispatchLoopPipeline } from "./project-dispatch-loop-pipeline.js";
import { ProjectDispatchSessionHelper } from "./project-dispatch-session-helper.js";
import { buildOrchestratorAgentCatalog } from "./shared/index.js";

export class ProjectDispatchService {
  private readonly launchAdapter: ProjectDispatchLaunchAdapter;
  private readonly selectionAdapter: ProjectDispatchSelectionAdapter;
  private readonly sessionHelper: ProjectDispatchSessionHelper;
  private readonly loopPipeline: ProjectDispatchLoopPipeline;

  constructor(private readonly context: ProjectDispatchContext) {
    this.launchAdapter = new ProjectDispatchLaunchAdapter({
      dataRoot: context.dataRoot,
      providerRegistry: context.providerRegistry,
      repositories: context.repositories
    });
    this.selectionAdapter = new ProjectDispatchSelectionAdapter(context.repositories);
    this.sessionHelper = new ProjectDispatchSessionHelper({
      dataRoot: context.dataRoot,
      repositories: context.repositories
    });
    this.loopPipeline = new ProjectDispatchLoopPipeline({
      dataRoot: context.dataRoot,
      repositories: context.repositories,
      inFlightDispatchSessionKeys: context.inFlightDispatchSessionKeys,
      buildSessionDispatchKey: context.buildSessionDispatchKey,
      completionCleanup: context.completionCleanup,
      selectionAdapter: this.selectionAdapter,
      launchAdapter: this.launchAdapter
    });
  }

  async dispatchProject(
    projectId: string,
    input: Omit<DispatchProjectInput, "mode"> & { mode?: "manual" | "loop" }
  ): Promise<ProjectDispatchResult> {
    const mode = input.mode ?? "manual";
    const scope = await this.context.repositories.resolveScope(projectId);
    const normalizedInput: DispatchProjectInput = {
      mode,
      sessionId: input.sessionId,
      messageId: input.messageId,
      taskId: input.taskId,
      force: input.force,
      onlyIdle: input.onlyIdle,
      maxDispatches: input.maxDispatches
    };

    const selectedSessions = await (normalizedInput.sessionId
      ? this.context.repositories.sessions
          .getSession(scope.paths, scope.project.projectId, normalizedInput.sessionId)
          .then((item) => (item ? [item] : []))
      : this.context.repositories.sessions.listSessions(scope.paths, scope.project.projectId));

    if (normalizedInput.sessionId && selectedSessions.length === 0) {
      return {
        projectId: scope.project.projectId,
        mode,
        results: [
          { sessionId: normalizedInput.sessionId, role: "unknown", outcome: "session_not_found", dispatchKind: null }
        ]
      };
    }

    if (normalizedInput.force && normalizedInput.taskId) {
      const allTasks = await this.context.repositories.taskboard.listTasks(scope.paths, scope.project.projectId);
      const targetTask = allTasks.find((item) => item.taskId === normalizedInput.taskId);
      if (!targetTask) {
        return {
          projectId: scope.project.projectId,
          mode,
          results: [
            {
              sessionId: normalizedInput.sessionId ?? "unknown",
              role: "unknown",
              outcome: "task_not_found",
              dispatchKind: "task",
              taskId: normalizedInput.taskId,
              reason: `task '${normalizedInput.taskId}' does not exist (hint: refresh task-tree and retry with current task_id)`
            }
          ]
        };
      }
      if (!isForceDispatchableState(targetTask.state)) {
        return {
          projectId: scope.project.projectId,
          mode,
          results: [
            {
              sessionId: targetTask.ownerSession ?? normalizedInput.sessionId ?? "unknown",
              role: targetTask.ownerRole,
              outcome: "task_not_force_dispatchable",
              dispatchKind: "task",
              taskId: normalizedInput.taskId,
              reason: `task '${normalizedInput.taskId}' state=${targetTask.state} is not force-dispatchable`
            }
          ]
        };
      }
    }

    const forceBootstrappedSessionId = await this.sessionHelper.bootstrapForceDispatchSession(
      scope.project,
      scope.paths,
      normalizedInput
    );
    const effectiveSessions = await this.sessionHelper.resolveEffectiveSessions(
      scope.project,
      scope.paths,
      normalizedInput,
      selectedSessions
    );
    if (normalizedInput.sessionId && effectiveSessions.length === 0) {
      return {
        projectId: scope.project.projectId,
        mode,
        results: [
          { sessionId: normalizedInput.sessionId, role: "unknown", outcome: "session_not_found", dispatchKind: null }
        ]
      };
    }

    const orderedSessions = await this.sessionHelper.resolveOrderedSessions(
      scope.project,
      scope.paths,
      effectiveSessions,
      normalizedInput,
      mode
    );
    if (normalizedInput.sessionId && orderedSessions.length === 0 && effectiveSessions[0]) {
      return {
        projectId: scope.project.projectId,
        mode,
        results: [
          {
            sessionId: effectiveSessions[0].sessionId,
            role: effectiveSessions[0].role,
            outcome: "session_busy",
            dispatchKind: null,
            reason: "session is not authoritative active session for role"
          }
        ]
      };
    }

    const agentList = await listAgents(this.context.dataRoot);
    const agentCatalog = buildOrchestratorAgentCatalog(agentList);
    const state: ProjectDispatchLoopState = {
      project: scope.project,
      paths: scope.paths,
      input: normalizedInput,
      orderedSessions,
      cursor: 0,
      rolePromptMap: agentCatalog.rolePromptMap,
      roleSummaryMap: agentCatalog.roleSummaryMap,
      registeredAgentIds: agentCatalog.agentIds,
      forceBootstrappedSessionId,
      dispatchedRoles: new Set<string>()
    };
    const maxDispatches =
      typeof normalizedInput.maxDispatches === "number" &&
      Number.isFinite(normalizedInput.maxDispatches) &&
      normalizedInput.maxDispatches > 0
        ? Math.floor(normalizedInput.maxDispatches)
        : Number.POSITIVE_INFINITY;
    const dispatchResult = await this.loopPipeline.run(state, maxDispatches);
    return {
      projectId: scope.project.projectId,
      mode,
      results: dispatchResult.results
    };
  }

  async dispatchMessage(
    projectId: string,
    input: { messageId: string; sessionId?: string; force?: boolean; onlyIdle?: boolean }
  ): Promise<ProjectDispatchResult> {
    return this.dispatchProject(projectId, {
      mode: "manual",
      sessionId: input.sessionId,
      messageId: input.messageId,
      force: input.force,
      onlyIdle: input.onlyIdle
    });
  }
}
