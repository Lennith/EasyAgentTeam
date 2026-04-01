import { listAgents } from "../../data/agent-store.js";
import type { ProjectDispatchLoopState } from "./project-dispatch-loop-pipeline.js";
import type {
  DispatchProjectInput,
  ProjectDispatchContext,
  ProjectDispatchResult
} from "./project-orchestrator-types.js";
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

    const forceValidationResult = await this.sessionHelper.validateForceDispatchTask(
      scope.project,
      scope.paths,
      normalizedInput
    );
    if (forceValidationResult) {
      return {
        projectId: scope.project.projectId,
        mode,
        results: [forceValidationResult]
      };
    }

    const resolvedSessions = await this.sessionHelper.resolveDispatchSessions(
      scope.project,
      scope.paths,
      normalizedInput,
      mode
    );
    if (resolvedSessions.preflightResult) {
      return {
        projectId: scope.project.projectId,
        mode,
        results: [resolvedSessions.preflightResult]
      };
    }

    const { orderedSessions, forceBootstrappedSessionId } = resolvedSessions;

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
