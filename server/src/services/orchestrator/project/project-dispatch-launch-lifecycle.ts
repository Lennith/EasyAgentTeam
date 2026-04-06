import { resolveSessionProviderId } from "../../provider-runtime.js";
import { ProjectDispatchEventAdapter } from "./project-dispatch-event-adapter.js";
import type {
  ProjectDispatchLaunchAdapterContext,
  ProjectDispatchLaunchContext,
  ProjectDispatchLaunchInput,
  ProjectDispatchLaunchOperations
} from "./project-dispatch-launch-adapter.js";
import type { SessionDispatchResult } from "./project-orchestrator-types.js";
import {
  buildProjectDispatchEventScope,
  buildProjectDispatchStartedScopeDetails
} from "./project-dispatch-run-lifecycle.js";
import {
  buildProjectDispatchExecutionDependencies,
  defaultProjectDispatchLaunchOperations,
  runProjectDispatchProviderLaunch
} from "./project-dispatch-provider-launch.js";
import { resolveOrchestratorErrorMessage, type OrchestratorLaunchExecutionAdapter } from "../shared/index.js";

export {
  appendProjectDispatchTerminalEventForContext,
  appendProjectTerminalDispatchEvent,
  buildProjectDispatchEventScope,
  buildProjectDispatchProviderPayload,
  buildProjectDispatchStartedDetails,
  buildProjectDispatchStartedScopeDetails,
  buildProjectDispatchRunnerScopePayload,
  buildProjectDispatchTerminalResult,
  buildProjectProviderDispatchInput,
  buildProjectRunnerPayload,
  finalizeProjectDispatchRunLifecycle,
  markProjectTaskDispatchedForContextIfNeeded
} from "./project-dispatch-run-lifecycle.js";
export { defaultProjectDispatchLaunchOperations } from "./project-dispatch-provider-launch.js";

export function createProjectDispatchLaunchExecutionAdapter(
  context: ProjectDispatchLaunchAdapterContext,
  operations: ProjectDispatchLaunchOperations = defaultProjectDispatchLaunchOperations,
  eventAdapter = context.eventAdapter ?? new ProjectDispatchEventAdapter(context.repositories)
): OrchestratorLaunchExecutionAdapter<
  ProjectDispatchLaunchInput,
  ProjectDispatchLaunchContext,
  SessionDispatchResult,
  SessionDispatchResult
> {
  const executionDependencies = buildProjectDispatchExecutionDependencies(context, operations, eventAdapter);

  return {
    createContext: async (input: ProjectDispatchLaunchInput) => {
      const providerFromSession =
        input.session.provider === "codex" || input.session.provider === "trae" || input.session.provider === "minimax"
          ? input.session.provider
          : null;
      return {
        input,
        providerId: providerFromSession ?? resolveSessionProviderId(input.project, input.session.role, "minimax"),
        dispatchId: operations.createDispatchId(),
        startedAt: operations.now()
      };
    },
    appendStarted: async (launchContext: ProjectDispatchLaunchContext) => {
      const { input } = launchContext;
      await eventAdapter.appendStarted(
        buildProjectDispatchEventScope(input.project, input.paths, input.session.sessionId, input.taskId || undefined),
        buildProjectDispatchStartedScopeDetails(launchContext)
      );
    },
    execute: async (launchContext: ProjectDispatchLaunchContext) => {
      const prepared = await operations.prepareProjectDispatchLaunch({
        dataRoot: context.dataRoot,
        project: launchContext.input.project,
        paths: launchContext.input.paths,
        session: launchContext.input.session,
        providerId: launchContext.providerId,
        taskId: launchContext.input.taskId,
        messages: launchContext.input.messages,
        allTasks: launchContext.input.allTasks,
        rolePromptMap: launchContext.input.rolePromptMap,
        roleSummaryMap: launchContext.input.roleSummaryMap,
        registeredAgentIds: launchContext.input.registeredAgentIds,
        startedAt: launchContext.startedAt,
        dispatchId: launchContext.dispatchId
      });
      return await runProjectDispatchProviderLaunch(executionDependencies, launchContext, prepared);
    },
    onSuccess: async (_launchContext: ProjectDispatchLaunchContext, result: SessionDispatchResult) => result,
    appendFailure: async (launchContext: ProjectDispatchLaunchContext, error: unknown) => {
      const reason = resolveOrchestratorErrorMessage(error);
      if (reason.includes("role.md")) {
        await context.repositories.events
          .appendEvent(launchContext.input.paths, {
            projectId: launchContext.input.project.projectId,
            eventType: "AGENT_ROLE_TEMPLATE_MISSING",
            source: "manager",
            sessionId: launchContext.input.session.sessionId,
            taskId: launchContext.input.taskId,
            payload: {
              role: launchContext.input.session.role,
              reason
            }
          })
          .catch(() => {});
      }
      await eventAdapter
        .appendFailed(
          buildProjectDispatchEventScope(
            launchContext.input.project,
            launchContext.input.paths,
            launchContext.input.session.sessionId,
            launchContext.input.taskId || undefined
          ),
          {
            ...buildProjectDispatchStartedScopeDetails(launchContext),
            error: reason
          }
        )
        .catch(() => {});
    },
    onFailure: async (launchContext: ProjectDispatchLaunchContext, error: unknown) => {
      const reason = resolveOrchestratorErrorMessage(error);
      await operations.markRunnerFatalError({
        dataRoot: context.dataRoot,
        project: launchContext.input.project,
        paths: launchContext.input.paths,
        sessionId: launchContext.input.session.sessionId,
        taskId: launchContext.input.taskId,
        messageId:
          launchContext.input.dispatchKind === "message"
            ? launchContext.input.firstMessage.envelope.message_id
            : undefined,
        dispatchId: launchContext.dispatchId,
        provider: launchContext.providerId,
        error: reason
      });
      return {
        sessionId: launchContext.input.session.sessionId,
        role: launchContext.input.session.role,
        outcome: "dispatch_failed",
        dispatchKind: launchContext.input.dispatchKind,
        reason,
        messageId: launchContext.input.firstMessage.envelope.message_id,
        requestId: launchContext.input.firstMessage.envelope.correlation.request_id,
        taskId: launchContext.input.taskId
      };
    }
  };
}
