import type {
  DispatchProjectInput,
  ProjectDispatchContext,
  ProjectDispatchResult
} from "./project-orchestrator-types.js";
import { ProjectDispatchSelectionAdapter } from "./project-dispatch-selection-adapter.js";
import { ProjectDispatchLaunchAdapter } from "./project-dispatch-launch-adapter.js";
import { createProjectDispatchLoopState, runProjectDispatchLoop } from "./project-dispatch-loop.js";
import {
  resolveProjectDispatchSessions,
  validateProjectForceDispatchTask
} from "./project-dispatch-session-resolution.js";

export class ProjectDispatchService {
  private readonly launchAdapter: ProjectDispatchLaunchAdapter;
  private readonly selectionAdapter: ProjectDispatchSelectionAdapter;

  constructor(private readonly context: ProjectDispatchContext) {
    this.launchAdapter = new ProjectDispatchLaunchAdapter({
      dataRoot: context.dataRoot,
      providerRegistry: context.providerRegistry,
      repositories: context.repositories
    });
    this.selectionAdapter = new ProjectDispatchSelectionAdapter(context.repositories);
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

    const forceValidationResult = await validateProjectForceDispatchTask(
      this.context,
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

    const resolvedSessions = await resolveProjectDispatchSessions(
      this.context,
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

    const { state, maxDispatches } = await createProjectDispatchLoopState({
      dataRoot: this.context.dataRoot,
      project: scope.project,
      paths: scope.paths,
      input: normalizedInput,
      orderedSessions: resolvedSessions.orderedSessions,
      forceBootstrappedSessionId: resolvedSessions.forceBootstrappedSessionId
    });
    const dispatchResult = await runProjectDispatchLoop(
      {
        context: this.context,
        launchAdapter: this.launchAdapter,
        selectionAdapter: this.selectionAdapter
      },
      state,
      maxDispatches
    );

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
