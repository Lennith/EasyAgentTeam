import type { ProviderRegistry } from "../../provider-runtime.js";
import { WorkflowDispatchEventAdapter } from "./workflow-dispatch-event-adapter.js";
import {
  defaultWorkflowDispatchLaunchPreparationOperations,
  prepareWorkflowDispatchLaunch
} from "./workflow-dispatch-launch-preparation.js";
import type {
  PreparedWorkflowDispatchLaunch,
  WorkflowDispatchLaunchPreparationOperations
} from "./workflow-dispatch-launch-preparation.js";
import {
  WorkflowDispatchConfigurationError,
  runWorkflowDispatchProviderLaunch
} from "./workflow-dispatch-provider-launch.js";
import {
  appendWorkflowMaxTokensRecoveryEvent,
  buildWorkflowDispatchEventScope,
  buildWorkflowDispatchStartedDetails,
  handleMissingWorkflowMiniMaxConfiguration,
  handleWorkflowDispatchLaunchError,
  handleWorkflowDispatchLaunchResult,
  type WorkflowDispatchLifecycleContext,
  type WorkflowDispatchRunResultMeta,
  type WorkflowMaxTokensRecoveryEvent
} from "./workflow-dispatch-run-lifecycle.js";
import type {
  WorkflowDispatchLaunchAdapterContext,
  WorkflowDispatchLaunchContext,
  WorkflowDispatchLaunchInput
} from "./workflow-dispatch-launch-adapter.js";
import { resolveOrchestratorProviderSessionId, type OrchestratorLaunchExecutionAdapter } from "../shared/index.js";

export {
  appendWorkflowMaxTokensRecoveryEvent,
  buildWorkflowDispatchEventScope,
  buildWorkflowDispatchStartedDetails,
  handleMissingWorkflowMiniMaxConfiguration,
  handleWorkflowDispatchLaunchError,
  handleWorkflowDispatchLaunchResult
} from "./workflow-dispatch-run-lifecycle.js";
export { defaultWorkflowDispatchLaunchPreparationOperations } from "./workflow-dispatch-launch-preparation.js";
export type {
  PreparedWorkflowDispatchLaunch,
  WorkflowDispatchLaunchPreparationOperations
} from "./workflow-dispatch-launch-preparation.js";
export type {
  WorkflowDispatchLifecycleContext,
  WorkflowDispatchRunResultMeta,
  WorkflowMaxTokensRecoveryEvent
} from "./workflow-dispatch-run-lifecycle.js";
export type {
  WorkflowRunRuntimeState,
  WorkflowTaskActionRequest,
  WorkflowTaskActionResult
} from "../../../domain/models.js";
export type { WorkflowRouteMessageInput } from "./workflow-message-routing-service.js";

export function createWorkflowDispatchLaunchExecutionAdapter(
  context: WorkflowDispatchLaunchAdapterContext,
  operations: WorkflowDispatchLaunchPreparationOperations = defaultWorkflowDispatchLaunchPreparationOperations,
  eventAdapter = context.eventAdapter ?? new WorkflowDispatchEventAdapter(context.repositories)
): OrchestratorLaunchExecutionAdapter<
  WorkflowDispatchLaunchInput,
  WorkflowDispatchLaunchContext,
  Awaited<ReturnType<ProviderRegistry["runSessionWithTools"]>>,
  void
> {
  return {
    createContext: async (input: WorkflowDispatchLaunchInput) => {
      const prepared = await prepareWorkflowDispatchLaunch(
        {
          dataRoot: context.dataRoot,
          run: input.run,
          role: input.role,
          session: input.session
        },
        operations
      );
      const lifecycleContext: WorkflowDispatchLifecycleContext = {
        runId: input.run.runId,
        sessionId: input.session.sessionId,
        taskId: input.taskId,
        requestId: input.requestId,
        dispatchId: input.dispatchId,
        dispatchKind: input.dispatchKind,
        messageId: input.messageId ?? null,
        recovery_attempt_id: input.recovery_attempt_id?.trim() || undefined,
        requestedSkillIds: prepared.requestedSkillIds,
        tokenLimit: prepared.tokenLimit,
        maxOutputTokens: prepared.maxOutputTokens,
        providerSessionId: resolveOrchestratorProviderSessionId(
          input.session.sessionId,
          input.session.providerSessionId
        ),
        errorStreak: input.session.errorStreak ?? 0
      };
      return {
        input,
        prepared,
        lifecycleContext
      };
    },
    appendStarted: async (launchContext: WorkflowDispatchLaunchContext) => {
      await eventAdapter.appendStarted(
        buildWorkflowDispatchEventScope(launchContext.lifecycleContext),
        buildWorkflowDispatchStartedDetails(launchContext.lifecycleContext)
      );
    },
    appendSuccess: async (
      launchContext: WorkflowDispatchLaunchContext,
      dispatchRunResult: Awaited<ReturnType<ProviderRegistry["runSessionWithTools"]>>
    ) => {
      await handleWorkflowDispatchLaunchResult(
        {
          repositories: context.repositories,
          eventAdapter
        },
        launchContext.lifecycleContext,
        dispatchRunResult as WorkflowDispatchRunResultMeta
      );
    },
    execute: async (launchContext: WorkflowDispatchLaunchContext) =>
      await runWorkflowDispatchProviderLaunch(context, launchContext),
    onSuccess: async () => {
      return;
    },
    appendFailure: async (launchContext: WorkflowDispatchLaunchContext, error: unknown) => {
      if (error instanceof WorkflowDispatchConfigurationError && error.message === "minimax_not_configured") {
        await handleMissingWorkflowMiniMaxConfiguration(
          {
            repositories: context.repositories,
            eventAdapter
          },
          launchContext.lifecycleContext
        );
        return;
      }
      await handleWorkflowDispatchLaunchError(
        {
          repositories: context.repositories,
          eventAdapter
        },
        launchContext.lifecycleContext,
        error
      );
    },
    onFailure: async () => {
      return;
    }
  };
}
