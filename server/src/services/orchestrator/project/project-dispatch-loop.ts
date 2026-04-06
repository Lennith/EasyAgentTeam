import { listAgents } from "../../../data/repository/catalog/agent-repository.js";
import type { ProjectPaths, ProjectRecord, SessionRecord } from "../../../domain/models.js";
import { resolveActiveSessionForRole } from "../../session-lifecycle-authority.js";
import type {
  DispatchProjectInput,
  ProjectDispatchContext,
  ProjectDispatchResult
} from "./project-orchestrator-types.js";
import type { ProjectDispatchLaunchAdapter } from "./project-dispatch-launch-adapter.js";
import type {
  ProjectDispatchSelection,
  ProjectDispatchSelectionAdapter
} from "./project-dispatch-selection-adapter.js";
import {
  buildOrchestratorAgentCatalog,
  evaluateOrchestratorDispatchSessionAvailability,
  runOrchestratorDispatchTemplate
} from "../shared/index.js";

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

export interface CreateProjectDispatchLoopStateInput {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  input: DispatchProjectInput;
  orderedSessions: SessionRecord[];
  forceBootstrappedSessionId: string | null;
}

export interface ProjectDispatchLoopDependencies {
  context: ProjectDispatchContext;
  launchAdapter: Pick<ProjectDispatchLaunchAdapter, "launch">;
  selectionAdapter: Pick<ProjectDispatchSelectionAdapter, "select">;
}

export async function createProjectDispatchLoopState(
  input: CreateProjectDispatchLoopStateInput
): Promise<{ state: ProjectDispatchLoopState; maxDispatches: number }> {
  const agentCatalog = buildOrchestratorAgentCatalog(await listAgents(input.dataRoot));
  const maxDispatches =
    typeof input.input.maxDispatches === "number" &&
    Number.isFinite(input.input.maxDispatches) &&
    input.input.maxDispatches > 0
      ? Math.floor(input.input.maxDispatches)
      : Number.POSITIVE_INFINITY;

  return {
    state: {
      project: input.project,
      paths: input.paths,
      input: input.input,
      orderedSessions: input.orderedSessions,
      cursor: 0,
      rolePromptMap: agentCatalog.rolePromptMap,
      roleSummaryMap: agentCatalog.roleSummaryMap,
      registeredAgentIds: agentCatalog.agentIds,
      forceBootstrappedSessionId: input.forceBootstrappedSessionId,
      dispatchedRoles: new Set<string>()
    },
    maxDispatches
  };
}

export async function runProjectDispatchLoop(
  dependencies: ProjectDispatchLoopDependencies,
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
    gate: dependencies.context.inFlightDispatchSessionKeys,
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
      selectNext: async (loopState) =>
        await selectNextProjectDispatch(dependencies.context, dependencies.selectionAdapter, loopState),
      getSingleFlightKey: ({ session }, loopState) =>
        dependencies.context.buildSessionDispatchKey(loopState.project.projectId, session.sessionId),
      createSingleFlightBusyResult: ({ session }) => ({
        sessionId: session.sessionId,
        role: session.role,
        outcome: "session_busy" as const,
        dispatchKind: null,
        reason: "session already dispatching"
      }),
      dispatch: async (_selection, preparedInput) => await dependencies.launchAdapter.launch(preparedInput),
      buildNoSelectionResult: () => null,
      shouldCountAsDispatch: (result) => result.outcome === "dispatched",
      shouldContinue: () => true
    },
    finalize: {
      afterDispatch: async (result, loopState) => {
        if (result.outcome === "dispatched") {
          loopState.dispatchedRoles.add(result.role);
          const freshProject = await dependencies.context.repositories.projectRuntime.getProject(
            loopState.project.projectId
          );
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

async function selectNextProjectDispatch(
  context: ProjectDispatchContext,
  selectionAdapter: Pick<ProjectDispatchSelectionAdapter, "select">,
  state: ProjectDispatchLoopState
): Promise<
  | { status: "selected"; selection: ProjectDispatchLoopSelection }
  | { status: "skipped"; result: ProjectDispatchResult["results"][number] }
  | { status: "none"; busyFound: boolean }
> {
  while (state.cursor < state.orderedSessions.length) {
    const session = state.orderedSessions[state.cursor];
    state.cursor += 1;
    const freshSession = await context.repositories.sessions.getSession(
      state.paths,
      state.project.projectId,
      session.sessionId
    );
    if (!freshSession || freshSession.status === "dismissed" || state.dispatchedRoles.has(freshSession.role)) {
      continue;
    }
    const authoritative = await resolveActiveSessionForRole({
      dataRoot: context.dataRoot,
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

    await context.completionCleanup(state.paths, state.project.projectId, authoritative.role);
    const selection = await selectionAdapter.select(
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
