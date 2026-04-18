import type { ProjectRepositoryBundle } from "../../../data/repository/project/repository-bundle.js";
import type { ProjectPaths, ProjectRecord, TaskRecord } from "../../../domain/models.js";
import type { ProjectDispatchInput as ProviderProjectDispatchInput } from "../../provider-runtime.js";
import { isProviderLaunchError, tryDeserializeProviderLaunchError } from "../../provider-launch-error.js";
import type { DispatchKind, DispatchProjectInput, SessionDispatchResult } from "./project-orchestrator-types.js";
import {
  ProjectDispatchEventAdapter,
  type ProjectDispatchEventScope,
  type ProjectDispatchFailedDetails,
  type ProjectDispatchFinishedDetails,
  type ProjectDispatchStartedDetails
} from "./project-dispatch-event-adapter.js";
import type {
  PreparedProjectDispatchLaunch,
  ProjectDispatchProviderId
} from "./project-dispatch-launch-preparation.js";
import type {
  ProjectDispatchLaunchContext,
  ProjectDispatchLaunchOperations
} from "./project-dispatch-launch-adapter.js";
import { applyOrchestratorDispatchTerminalState } from "../shared/index.js";

type ProjectDispatchEventWriter = {
  appendFinished(scope: ProjectDispatchEventScope, details: ProjectDispatchFinishedDetails): Promise<void>;
  appendFailed(scope: ProjectDispatchEventScope, details: ProjectDispatchFailedDetails): Promise<void>;
};

interface ProjectDispatchTerminalDetails {
  dispatchFailedReason: string | null;
  runId: string;
  exitCode: number | null;
  timedOut: boolean;
  startedAt: string;
  finishedAt: string;
}

interface BuildProjectProviderDispatchInputArgs {
  sessionId: string;
  prompt: string;
  dispatchId: string;
  taskId: string;
  activeTask: Pick<TaskRecord, "title" | "parentTaskId" | "rootTaskId"> | null;
  requestId: string;
  parentRequestId?: string | null;
  agentRole: string;
  modelCommand: string | undefined;
  modelParams: Record<string, string>;
}

interface BuildProjectRunnerPayloadArgs {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  sessionId: string;
  taskId: string;
  dispatchKind: DispatchKind;
  dispatchId: string;
  messageId?: string;
}

interface ProjectDispatchLifecycleResultInput {
  runId: string;
  sessionId?: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
  provider: ProjectDispatchProviderId;
  providerSessionId?: string | null;
}

interface ProjectDispatchRunOutcomeLike {
  runId: string;
  exitCode: number | null;
  timedOut: boolean;
  finishedAt?: string;
  sessionId?: string;
  error?: string;
}

interface ProjectDispatchLifecycleDependencies {
  operations: Pick<
    ProjectDispatchLaunchOperations,
    | "markRunnerTimeout"
    | "markRunnerSuccess"
    | "markRunnerRetryableError"
    | "markRunnerTransientError"
    | "markRunnerFatalError"
  >;
  helpers: {
    buildRunnerPayload(
      context: ProjectDispatchLaunchContext,
      runId?: string,
      sessionId?: string
    ): Parameters<ProjectDispatchLaunchOperations["markRunnerStarted"]>[0];
  };
}

export function buildProjectDispatchEventScope(
  project: ProjectRecord,
  paths: ProjectPaths,
  sessionId: string,
  taskId?: string
): ProjectDispatchEventScope {
  return {
    project,
    paths,
    sessionId,
    taskId
  };
}

export function buildProjectDispatchStartedDetails(input: {
  dispatchId: string;
  dispatchKind: DispatchKind;
  requestId: string;
  mode: DispatchProjectInput["mode"];
  messageIds: string[];
}): ProjectDispatchStartedDetails {
  return {
    dispatchId: input.dispatchId,
    dispatchKind: input.dispatchKind,
    requestId: input.requestId,
    mode: input.mode,
    messageIds: input.messageIds
  };
}

export async function appendProjectTerminalDispatchEvent(
  eventAdapter: ProjectDispatchEventWriter,
  scope: ProjectDispatchEventScope,
  baseDetails: ProjectDispatchStartedDetails,
  details: ProjectDispatchTerminalDetails
): Promise<void> {
  if (details.dispatchFailedReason) {
    const failedDetails: ProjectDispatchFailedDetails = {
      ...baseDetails,
      runId: details.runId,
      exitCode: details.exitCode,
      timedOut: details.timedOut,
      startedAt: details.startedAt,
      finishedAt: details.finishedAt,
      error: details.dispatchFailedReason
    };
    await eventAdapter.appendFailed(scope, failedDetails);
    return;
  }

  const finishedDetails: ProjectDispatchFinishedDetails = {
    ...baseDetails,
    runId: details.runId,
    exitCode: details.exitCode,
    timedOut: details.timedOut,
    startedAt: details.startedAt,
    finishedAt: details.finishedAt
  };
  await eventAdapter.appendFinished(scope, finishedDetails);
}

export function buildProjectProviderDispatchInput(
  input: BuildProjectProviderDispatchInputArgs,
  extra: Partial<ProviderProjectDispatchInput> = {}
): ProviderProjectDispatchInput {
  return {
    sessionId: input.sessionId,
    prompt: input.prompt,
    dispatchId: input.dispatchId,
    taskId: input.taskId,
    activeTaskTitle: input.activeTask?.title ?? "",
    activeParentTaskId: input.activeTask?.parentTaskId ?? "",
    activeRootTaskId: input.activeTask?.rootTaskId ?? "",
    activeRequestId: input.requestId,
    parentRequestId: input.parentRequestId ?? input.requestId,
    agentRole: input.agentRole,
    modelCommand: input.modelCommand,
    modelParams: input.modelParams,
    ...extra
  };
}

export function buildProjectRunnerPayload(
  input: BuildProjectRunnerPayloadArgs,
  runId?: string,
  sessionId = input.sessionId
): {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  sessionId: string;
  taskId: string;
  messageId?: string;
  runId?: string;
  dispatchId: string;
} {
  return {
    dataRoot: input.dataRoot,
    project: input.project,
    paths: input.paths,
    sessionId,
    taskId: input.taskId,
    messageId: input.dispatchKind === "message" ? input.messageId : undefined,
    runId,
    dispatchId: input.dispatchId
  };
}

export function buildProjectDispatchStartedScopeDetails(context: ProjectDispatchLaunchContext) {
  return buildProjectDispatchStartedDetails({
    dispatchId: context.dispatchId,
    dispatchKind: context.input.dispatchKind,
    requestId: context.input.firstMessage.envelope.correlation.request_id,
    mode: context.input.input.mode,
    messageIds: context.input.selectedMessageIds
  });
}

export function buildProjectDispatchProviderPayload(
  context: ProjectDispatchLaunchContext,
  prepared: PreparedProjectDispatchLaunch,
  extra: Partial<ProviderProjectDispatchInput> = {}
): ProviderProjectDispatchInput {
  const { input } = context;
  return buildProjectProviderDispatchInput(
    {
      sessionId: input.session.sessionId,
      prompt: prepared.prompt,
      dispatchId: context.dispatchId,
      taskId: input.taskId,
      activeTask: input.activeTask,
      requestId: input.firstMessage.envelope.correlation.request_id,
      parentRequestId: input.firstMessage.envelope.correlation.parent_request_id,
      agentRole: input.session.role,
      modelCommand: prepared.modelCommand,
      modelParams: prepared.modelParams
    },
    extra
  );
}

export function buildProjectDispatchRunnerScopePayload(
  dataRoot: string,
  context: ProjectDispatchLaunchContext,
  runId?: string,
  sessionId = context.input.session.sessionId
) {
  return buildProjectRunnerPayload(
    {
      dataRoot,
      project: context.input.project,
      paths: context.input.paths,
      sessionId: context.input.session.sessionId,
      taskId: context.input.taskId,
      dispatchKind: context.input.dispatchKind,
      dispatchId: context.dispatchId,
      messageId: context.input.firstMessage.envelope.message_id
    },
    runId,
    sessionId
  );
}

export async function appendProjectDispatchTerminalEventForContext(
  eventAdapter: ProjectDispatchEventAdapter,
  repositories: Pick<ProjectRepositoryBundle, "events">,
  context: ProjectDispatchLaunchContext,
  sessionId: string,
  details: {
    dispatchFailedReason: string | null;
    runId: string;
    exitCode: number | null;
    timedOut: boolean;
    finishedAt: string;
  }
): Promise<void> {
  await applyOrchestratorDispatchTerminalState(
    async () => await repositories.events.listEvents(context.input.paths),
    sessionId,
    context.dispatchId,
    async () => {
      await appendProjectTerminalDispatchEvent(
        eventAdapter,
        buildProjectDispatchEventScope(
          context.input.project,
          context.input.paths,
          sessionId,
          context.input.taskId || undefined
        ),
        buildProjectDispatchStartedScopeDetails(context),
        {
          dispatchFailedReason: details.dispatchFailedReason,
          runId: details.runId,
          exitCode: details.exitCode,
          timedOut: details.timedOut,
          startedAt: context.startedAt,
          finishedAt: details.finishedAt
        }
      );
    }
  );
}

export async function markProjectTaskDispatchedForContextIfNeeded(
  repositories: Pick<ProjectRepositoryBundle, "taskboard">,
  context: ProjectDispatchLaunchContext
): Promise<void> {
  const { input } = context;
  if (input.dispatchKind !== "task" || !input.taskId) {
    return;
  }
  const currentTask = (await repositories.taskboard.listTasks(input.paths, input.project.projectId)).find(
    (task) => task.taskId === input.taskId
  );
  if (
    currentTask &&
    currentTask.state !== "DISPATCHED" &&
    currentTask.state !== "IN_PROGRESS" &&
    currentTask.state !== "DONE" &&
    currentTask.state !== "CANCELED"
  ) {
    await repositories.taskboard.patchTask(input.paths, input.project.projectId, input.taskId, {
      state: "DISPATCHED",
      grantedAt: new Date().toISOString()
    });
  }
}

export async function finalizeProjectDispatchRunLifecycle(
  dependencies: ProjectDispatchLifecycleDependencies,
  context: ProjectDispatchLaunchContext,
  input: ProjectDispatchLifecycleResultInput
): Promise<string | null> {
  const sessionId = input.sessionId ?? context.input.session.sessionId;
  const runnerPayload = dependencies.helpers.buildRunnerPayload(context, input.runId, sessionId);
  if (input.timedOut) {
    const timeoutResult = await dependencies.operations.markRunnerTimeout({
      ...runnerPayload,
      providerSessionId: input.providerSessionId,
      provider: input.provider
    });
    return timeoutResult.escalated ? "runner timeout escalated" : null;
  }
  if (input.exitCode === 0) {
    await dependencies.operations.markRunnerSuccess({
      ...runnerPayload,
      providerSessionId: input.providerSessionId,
      provider: input.provider
    });
    return null;
  }
  const failedReason = input.error ?? `runner exited with code ${input.exitCode}`;
  const providerError =
    (isProviderLaunchError(input.error) ? input.error : undefined) ?? tryDeserializeProviderLaunchError(input.error);
  if (providerError?.retryable && providerError.code === "PROVIDER_UPSTREAM_TRANSIENT_ERROR") {
    const markTransientError =
      dependencies.operations.markRunnerTransientError ?? dependencies.operations.markRunnerRetryableError;
    await markTransientError({
      ...runnerPayload,
      providerSessionId: input.providerSessionId,
      provider: input.provider,
      error: providerError.message,
      code: providerError.code,
      nextAction: providerError.nextAction,
      rawStatus: providerError.details?.status as number | string | null | undefined
    });
    return providerError.message;
  }
  const markFailure =
    context.input.dispatchKind === "message"
      ? dependencies.operations.markRunnerRetryableError
      : dependencies.operations.markRunnerFatalError;
  await markFailure({
    ...runnerPayload,
    providerSessionId: input.providerSessionId,
    provider: input.provider,
    error: failedReason
  });
  return failedReason;
}

export function buildProjectDispatchTerminalResult(
  context: ProjectDispatchLaunchContext,
  run: ProjectDispatchRunOutcomeLike,
  dispatchFailedReason: string | null
): SessionDispatchResult {
  const { input } = context;
  const baseResult = {
    sessionId: input.session.sessionId,
    role: input.session.role,
    dispatchKind: input.dispatchKind,
    messageId: input.firstMessage.envelope.message_id,
    requestId: input.firstMessage.envelope.correlation.request_id,
    runId: run.runId,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    taskId: input.taskId
  } satisfies Omit<SessionDispatchResult, "outcome" | "reason">;

  if (dispatchFailedReason) {
    return {
      ...baseResult,
      outcome: "dispatch_failed",
      reason: dispatchFailedReason
    };
  }

  return {
    ...baseResult,
    outcome: "dispatched"
  };
}
