import type { ProjectPaths, ProjectRecord, SessionRecord } from "../../domain/models.js";
import type { ProjectRepositoryBundle } from "../../data/repository/project-repository-bundle.js";
import { resolveActiveSessionForRole } from "../session-lifecycle-authority.js";
import type { OrchestratorSingleFlightGate } from "./kernel/single-flight.js";
import type { ProjectDispatchLaunchAdapter } from "./project-dispatch-launch-adapter.js";
import type {
  ProjectDispatchSelection,
  ProjectDispatchSelectionAdapter
} from "./project-dispatch-selection-adapter.js";
import type { DispatchProjectInput, ProjectDispatchResult } from "./project-orchestrator-types.js";
import { evaluateOrchestratorDispatchSessionAvailability, runOrchestratorDispatchTemplate } from "./shared/index.js";

interface ProjectDispatchLoopSelection {
  session: SessionRecord;
  selection: ProjectDispatchSelection;
}

export interface ProjectDispatchLoopState {
  project: ProjectRecord;
  paths: ProjectPaths;
  input: DispatchProjectInput;
  orderedSessions: SessionRecord[];
  cursor: number;
  rolePromptMap: Map<string, string>;
  roleSummaryMap: Map<string, string>;
  registeredAgentIds: string[];
  forceBootstrappedSessionId: string | null;
  dispatchedRoles: Set<string>;
}

interface ProjectDispatchLoopPipelineContext {
  dataRoot: string;
  repositories: ProjectRepositoryBundle;
  inFlightDispatchSessionKeys: OrchestratorSingleFlightGate;
  buildSessionDispatchKey(projectId: string, sessionId: string): string;
  completionCleanup(paths: ProjectPaths, projectId: string, role: string): Promise<number>;
  selectionAdapter: ProjectDispatchSelectionAdapter;
  launchAdapter: ProjectDispatchLaunchAdapter;
}

export class ProjectDispatchLoopPipeline {
  constructor(private readonly context: ProjectDispatchLoopPipelineContext) {}

  async run(
    state: ProjectDispatchLoopState,
    maxDispatches: number
  ): Promise<{
    results: ProjectDispatchResult["results"];
    dispatchedCount: number;
  }> {
    return await runOrchestratorDispatchTemplate<
      ProjectDispatchLoopState,
      ProjectDispatchLoopSelection,
      Parameters<ProjectDispatchLaunchAdapter["launch"]>[0],
      ProjectDispatchResult["results"][number]
    >({
      state,
      gate: this.context.inFlightDispatchSessionKeys,
      maxDispatches,
      preflight: {
        beforeLoop: async () => null
      },
      mutation: {
        prepareDispatch: async ({ session, selection }, loopState) => ({
          project: loopState.project,
          paths: loopState.paths,
          session,
          taskId: selection.taskId ?? "",
          input: loopState.input,
          dispatchKind: selection.dispatchKind,
          selectedMessageIds: selection.selectedMessageIds,
          messages: selection.messages,
          allTasks: selection.allTasks,
          firstMessage: selection.message!,
          activeTask: selection.task,
          rolePromptMap: loopState.rolePromptMap,
          roleSummaryMap: loopState.roleSummaryMap,
          registeredAgentIds: loopState.registeredAgentIds
        })
      },
      execution: {
        selectNext: async (loopState) => await this.selectNextDispatch(loopState),
        getSingleFlightKey: ({ session }, loopState) =>
          this.context.buildSessionDispatchKey(loopState.project.projectId, session.sessionId),
        createSingleFlightBusyResult: ({ session }) => ({
          sessionId: session.sessionId,
          role: session.role,
          outcome: "session_busy",
          dispatchKind: null,
          reason: "session already dispatching"
        }),
        dispatch: async (_selection, preparedInput) => await this.context.launchAdapter.launch(preparedInput),
        buildNoSelectionResult: () => null,
        shouldCountAsDispatch: (result) => result.outcome === "dispatched",
        shouldContinue: () => true
      },
      finalize: {
        afterDispatch: async (result, loopState) => {
          if (result.outcome === "dispatched") {
            loopState.dispatchedRoles.add(result.role);
            const freshProject = await this.context.repositories.projectRuntime.getProject(loopState.project.projectId);
            loopState.project.roleMessageStatus = freshProject.roleMessageStatus;
          }
          if (loopState.forceBootstrappedSessionId) {
            result.sessionBootstrapped = true;
            result.resolvedSessionId = result.sessionId;
            if (result.outcome === "dispatched") {
              result.reason = `session_bootstrapped: ${loopState.forceBootstrappedSessionId}`;
            }
          }
        }
      }
    });
  }

  private async selectNextDispatch(
    state: ProjectDispatchLoopState
  ): Promise<
    | { status: "selected"; selection: ProjectDispatchLoopSelection }
    | { status: "skipped"; result: ProjectDispatchResult["results"][number] }
    | { status: "none"; busyFound: boolean }
  > {
    while (state.cursor < state.orderedSessions.length) {
      const session = state.orderedSessions[state.cursor];
      state.cursor += 1;
      const freshSession = await this.context.repositories.sessions.getSession(
        state.paths,
        state.project.projectId,
        session.sessionId
      );
      if (!freshSession || freshSession.status === "dismissed" || state.dispatchedRoles.has(freshSession.role)) {
        continue;
      }
      const authoritative = await resolveActiveSessionForRole({
        dataRoot: this.context.dataRoot,
        project: state.project,
        paths: state.paths,
        role: freshSession.role,
        reason: "dispatch_session_iteration"
      });
      if (!authoritative || authoritative.sessionId !== freshSession.sessionId) {
        continue;
      }
      const availability = evaluateOrchestratorDispatchSessionAvailability({
        sessionStatus: authoritative.status,
        onlyIdle: false,
        force: Boolean(state.input.force),
        cooldownUntil: authoritative.cooldownUntil,
        treatRunningAsBusy: false
      });
      if (!availability.available) {
        return {
          status: "skipped",
          result: {
            sessionId: authoritative.sessionId,
            role: authoritative.role,
            outcome: "session_busy",
            dispatchKind: null,
            reason: availability.reason ?? "session unavailable"
          }
        };
      }

      await this.context.completionCleanup(state.paths, state.project.projectId, authoritative.role);
      const selection = await this.context.selectionAdapter.select(
        {
          project: state.project,
          paths: state.paths,
          session: authoritative
        },
        state.input
      );
      if (selection.status === "skipped") {
        return selection;
      }
      if (!selection.selection.message || !selection.selection.dispatchKind) {
        return {
          status: "skipped",
          result: {
            sessionId: authoritative.sessionId,
            role: authoritative.role,
            outcome: "dispatch_failed",
            dispatchKind: selection.selection.dispatchKind,
            reason: "selection produced no dispatchable message"
          }
        };
      }
      return {
        status: "selected",
        selection: {
          session: authoritative,
          selection: selection.selection
        }
      };
    }

    return {
      status: "none",
      busyFound: false
    };
  }
}
