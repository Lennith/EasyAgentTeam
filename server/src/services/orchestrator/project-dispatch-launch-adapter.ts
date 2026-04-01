import { randomUUID } from "node:crypto";
import { addPendingMessagesForRole, confirmPendingMessagesForRole } from "../../data/role-message-status-store.js";
import { getRuntimeSettings, type RuntimeSettings } from "../../data/runtime-settings-store.js";
import type { ProjectRepositoryBundle } from "../../data/repository/project-repository-bundle.js";
import type {
  ManagerToAgentMessage,
  ProjectPaths,
  ProjectRecord,
  SessionRecord,
  TaskRecord
} from "../../domain/models.js";
import {
  resolveSessionProviderId,
  type ProjectDispatchInput as ProviderProjectDispatchInput,
  type ProviderRegistry
} from "../provider-runtime.js";
import {
  markRunnerFatalError,
  markRunnerStarted,
  markRunnerSuccess,
  markRunnerTimeout
} from "../session-lifecycle-authority.js";
import type { MiniMaxRunResultInternal } from "../minimax-runner.js";
import type { DispatchKind, DispatchProjectInput, SessionDispatchResult } from "./project-orchestrator-types.js";
import {
  ProjectDispatchEventAdapter,
  type ProjectDispatchEventScope,
  type ProjectDispatchFailedDetails,
  type ProjectDispatchFinishedDetails,
  type ProjectDispatchStartedDetails
} from "./project-dispatch-event-adapter.js";
import { isPendingSessionId } from "./project-dispatch-policy.js";
import {
  prepareProjectDispatchLaunch,
  type PreparedProjectDispatchLaunch,
  type ProjectDispatchProviderId
} from "./project-dispatch-launch-preparation.js";
import {
  applyOrchestratorDispatchTerminalState,
  executeOrchestratorLaunch,
  type OrchestratorDispatchLaunchAdapter,
  type OrchestratorLaunchExecutionAdapter,
  resolveOrchestratorErrorMessage
} from "./shared/index.js";

interface ProjectDispatchLaunchContext {
  input: ProjectDispatchLaunchInput;
  providerId: ProjectDispatchProviderId;
  dispatchId: string;
  startedAt: string;
}

interface ProjectDispatchLaunchInput {
  project: ProjectRecord;
  paths: ProjectPaths;
  session: SessionRecord;
  taskId: string;
  input: DispatchProjectInput;
  dispatchKind: DispatchKind;
  selectedMessageIds: string[];
  messages: ManagerToAgentMessage[];
  allTasks: TaskRecord[];
  firstMessage: ManagerToAgentMessage;
  activeTask: TaskRecord | null;
  rolePromptMap: Map<string, string>;
  roleSummaryMap: Map<string, string>;
  registeredAgentIds: string[];
}

interface ProjectDispatchLaunchAdapterContext {
  dataRoot: string;
  providerRegistry: ProviderRegistry;
  repositories: ProjectRepositoryBundle;
  eventAdapter?: ProjectDispatchEventAdapter;
}

interface ProjectDispatchLaunchOperations {
  now(): string;
  createDispatchId(): string;
  getRuntimeSettings(dataRoot: string): Promise<RuntimeSettings>;
  prepareProjectDispatchLaunch: typeof prepareProjectDispatchLaunch;
  addPendingMessagesForRole: typeof addPendingMessagesForRole;
  confirmPendingMessagesForRole: typeof confirmPendingMessagesForRole;
  markRunnerStarted: typeof markRunnerStarted;
  markRunnerSuccess: typeof markRunnerSuccess;
  markRunnerTimeout: typeof markRunnerTimeout;
  markRunnerFatalError: typeof markRunnerFatalError;
}

interface ProjectDispatchLaunchExecutionHelpers {
  buildProviderDispatchPayload(
    context: ProjectDispatchLaunchContext,
    prepared: PreparedProjectDispatchLaunch,
    extra?: Partial<ProviderProjectDispatchInput>
  ): ProviderProjectDispatchInput;
  buildRunnerPayload(
    context: ProjectDispatchLaunchContext,
    runId?: string,
    sessionId?: string
  ): Parameters<ProjectDispatchLaunchOperations["markRunnerStarted"]>[0];
  appendTerminalDispatchEvent(
    context: ProjectDispatchLaunchContext,
    sessionId: string,
    details: {
      dispatchFailedReason: string | null;
      runId: string;
      exitCode: number | null;
      timedOut: boolean;
      finishedAt: string;
    }
  ): Promise<void>;
  markTaskDispatchedIfNeeded(context: ProjectDispatchLaunchContext): Promise<void>;
}

interface ProjectDispatchLaunchExecutionDependencies {
  context: ProjectDispatchLaunchAdapterContext;
  operations: ProjectDispatchLaunchOperations;
  helpers: ProjectDispatchLaunchExecutionHelpers;
}

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
  operations: Pick<ProjectDispatchLaunchOperations, "markRunnerTimeout" | "markRunnerSuccess" | "markRunnerFatalError">;
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
  await dependencies.operations.markRunnerFatalError({
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

const defaultProjectDispatchLaunchOperations: ProjectDispatchLaunchOperations = {
  now: () => new Date().toISOString(),
  createDispatchId: () => randomUUID(),
  getRuntimeSettings,
  prepareProjectDispatchLaunch,
  addPendingMessagesForRole,
  confirmPendingMessagesForRole,
  markRunnerStarted,
  markRunnerSuccess,
  markRunnerTimeout,
  markRunnerFatalError
};

async function handleProjectMiniMaxWakeUp(
  dependencies: ProjectDispatchLaunchExecutionDependencies,
  context: ProjectDispatchLaunchContext,
  sessionId: string,
  runId: string
): Promise<void> {
  const { input } = context;
  await dependencies.operations.confirmPendingMessagesForRole(input.paths, input.project.projectId, input.session.role);
  await dependencies.helpers.markTaskDispatchedIfNeeded(context);
  await dependencies.operations.markRunnerStarted({
    ...dependencies.helpers.buildRunnerPayload(context, runId, sessionId),
    provider: "minimax"
  });
}

async function handleProjectMiniMaxCompletion(
  dependencies: ProjectDispatchLaunchExecutionDependencies,
  context: ProjectDispatchLaunchContext,
  result: MiniMaxRunResultInternal,
  sessionId: string,
  runId: string
): Promise<void> {
  const { input } = context;
  await dependencies.operations.confirmPendingMessagesForRole(input.paths, input.project.projectId, input.session.role);
  const dispatchFailedReason = await finalizeProjectDispatchRunLifecycle(dependencies, context, {
    runId,
    sessionId,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    error: result.error,
    provider: "minimax",
    providerSessionId: result.timedOut ? undefined : (result.sessionId ?? null)
  });
  await dependencies.helpers.appendTerminalDispatchEvent(context, sessionId, {
    dispatchFailedReason,
    runId,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    finishedAt: result.finishedAt
  });
}

async function runProjectMiniMaxDispatch(
  dependencies: ProjectDispatchLaunchExecutionDependencies,
  context: ProjectDispatchLaunchContext,
  prepared: PreparedProjectDispatchLaunch
): Promise<SessionDispatchResult> {
  const { input } = context;
  const runtimeSettings = await dependencies.operations.getRuntimeSettings(dependencies.context.dataRoot);
  await dependencies.operations.addPendingMessagesForRole(
    input.paths,
    input.project.projectId,
    input.session.role,
    input.selectedMessageIds.map((messageId) => ({
      messageId,
      dispatchedAt: new Date().toISOString()
    }))
  );

  let expectedRunId: string | null = null;
  const launchResult = await dependencies.context.providerRegistry.launchProjectDispatch(
    context.providerId,
    input.project,
    input.paths,
    dependencies.helpers.buildProviderDispatchPayload(context, prepared),
    runtimeSettings,
    {
      wakeUpCallback: async (sessionId, runId) => {
        if (expectedRunId && expectedRunId !== runId) {
          return;
        }
        await handleProjectMiniMaxWakeUp(dependencies, context, sessionId, runId);
      },
      completionCallback: async (result, sessionId, runId) => {
        if (expectedRunId && expectedRunId !== runId) {
          return;
        }
        await handleProjectMiniMaxCompletion(dependencies, context, result, sessionId, runId);
      }
    }
  );
  if (launchResult.mode !== "async") {
    throw new Error(`provider '${context.providerId}' expected async launch mode for project dispatch`);
  }
  expectedRunId = launchResult.runId;
  return {
    sessionId: input.session.sessionId,
    role: input.session.role,
    outcome: "dispatched",
    dispatchKind: input.dispatchKind,
    messageId: input.firstMessage.envelope.message_id,
    requestId: input.firstMessage.envelope.correlation.request_id,
    runId: launchResult.runId,
    exitCode: null,
    timedOut: false,
    taskId: input.taskId
  };
}

async function runProjectSyncDispatch(
  dependencies: ProjectDispatchLaunchExecutionDependencies,
  context: ProjectDispatchLaunchContext,
  prepared: PreparedProjectDispatchLaunch
): Promise<SessionDispatchResult> {
  const { input } = context;
  const runtimeSettings = await dependencies.operations.getRuntimeSettings(dependencies.context.dataRoot);
  const resumeCandidate =
    input.session.providerSessionId?.trim() ||
    (!isPendingSessionId(input.session.sessionId) ? input.session.sessionId : "");
  const canAttemptResume = context.providerId === "codex" && Boolean(resumeCandidate);
  await dependencies.operations.markRunnerStarted({
    ...dependencies.helpers.buildRunnerPayload(context),
    provider: context.providerId
  });

  let run: {
    runId: string;
    exitCode: number | null;
    timedOut: boolean;
    finishedAt?: string;
    sessionId?: string;
    error?: string;
  } | null = null;
  let runError: unknown = null;
  let resumedFailedAndReset = false;

  try {
    const launchResult = await dependencies.context.providerRegistry.launchProjectDispatch(
      context.providerId,
      input.project,
      input.paths,
      dependencies.helpers.buildProviderDispatchPayload(context, prepared, { resumeSessionId: resumeCandidate }),
      runtimeSettings
    );
    if (launchResult.mode !== "sync") {
      throw new Error(`provider '${context.providerId}' returned async launch mode for sync project dispatch`);
    }
    run = launchResult.result;
  } catch (error) {
    runError = error;
  }

  if (canAttemptResume && runError !== null) {
    await dependencies.context.repositories.events.appendEvent(input.paths, {
      projectId: input.project.projectId,
      eventType: "CODEX_RESUME_FAILED",
      source: "manager",
      sessionId: input.session.sessionId,
      taskId: input.taskId,
      payload: {
        requestId: input.firstMessage.envelope.correlation.request_id,
        resumeSessionId: resumeCandidate || null,
        error: runError instanceof Error ? runError.message : String(runError)
      }
    });
    resumedFailedAndReset = true;
    await dependencies.context.repositories.sessions.touchSession(
      input.paths,
      input.project.projectId,
      input.session.sessionId,
      {
        providerSessionId: null
      }
    );
    run = null;
    runError = null;
    await dependencies.context.repositories.events.appendEvent(input.paths, {
      projectId: input.project.projectId,
      eventType: "CODEX_RESUME_FALLBACK_EXEC",
      source: "manager",
      sessionId: input.session.sessionId,
      taskId: input.taskId,
      payload: {
        requestId: input.firstMessage.envelope.correlation.request_id,
        previousResumeSessionId: resumeCandidate || null
      }
    });
    try {
      const fallbackResult = await dependencies.context.providerRegistry.launchProjectDispatch(
        context.providerId,
        input.project,
        input.paths,
        dependencies.helpers.buildProviderDispatchPayload(context, prepared),
        runtimeSettings
      );
      if (fallbackResult.mode !== "sync") {
        throw new Error(`provider '${context.providerId}' returned async launch mode for sync project dispatch`);
      }
      run = fallbackResult.result;
    } catch (fallbackError) {
      runError = fallbackError;
    }
  }

  if (runError || !run) {
    throw runError instanceof Error ? runError : new Error(runError ? String(runError) : "model run failed");
  }

  if (input.dispatchKind === "message") {
    await dependencies.operations.addPendingMessagesForRole(
      input.paths,
      input.project.projectId,
      input.session.role,
      input.selectedMessageIds.map((messageId) => ({
        messageId,
        dispatchedAt: new Date().toISOString()
      }))
    );
  }
  await dependencies.operations.confirmPendingMessagesForRole(input.paths, input.project.projectId, input.session.role);
  await dependencies.helpers.markTaskDispatchedIfNeeded(context);

  const nextProviderSessionId = run.sessionId ?? (resumedFailedAndReset ? undefined : resumeCandidate || undefined);
  const dispatchFailedReason = await finalizeProjectDispatchRunLifecycle(dependencies, context, {
    runId: run.runId,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    error: run.error,
    provider: context.providerId,
    providerSessionId: nextProviderSessionId ?? null
  });
  await dependencies.helpers.appendTerminalDispatchEvent(context, input.session.sessionId, {
    dispatchFailedReason,
    runId: run.runId,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    finishedAt: run.finishedAt ?? new Date().toISOString()
  });

  return buildProjectDispatchTerminalResult(context, run, dispatchFailedReason);
}

export class ProjectDispatchLaunchAdapter
  implements
    OrchestratorDispatchLaunchAdapter<ProjectDispatchLaunchInput, SessionDispatchResult>,
    OrchestratorLaunchExecutionAdapter<
      ProjectDispatchLaunchInput,
      ProjectDispatchLaunchContext,
      SessionDispatchResult,
      SessionDispatchResult
    >
{
  private readonly eventAdapter: ProjectDispatchEventAdapter;

  constructor(
    private readonly context: ProjectDispatchLaunchAdapterContext,
    private readonly operations: ProjectDispatchLaunchOperations = defaultProjectDispatchLaunchOperations
  ) {
    this.eventAdapter = context.eventAdapter ?? new ProjectDispatchEventAdapter(context.repositories);
  }

  async launch(input: ProjectDispatchLaunchInput): Promise<SessionDispatchResult> {
    return await executeOrchestratorLaunch(input, this);
  }

  async createContext(input: ProjectDispatchLaunchInput): Promise<ProjectDispatchLaunchContext> {
    const providerFromSession =
      input.session.provider === "codex" || input.session.provider === "trae" || input.session.provider === "minimax"
        ? input.session.provider
        : null;
    return {
      input,
      providerId: providerFromSession ?? resolveSessionProviderId(input.project, input.session.role, "minimax"),
      dispatchId: this.operations.createDispatchId(),
      startedAt: this.operations.now()
    };
  }

  async appendStarted(context: ProjectDispatchLaunchContext): Promise<void> {
    const { input } = context;
    await this.eventAdapter.appendStarted(
      buildProjectDispatchEventScope(input.project, input.paths, input.session.sessionId, input.taskId || undefined),
      buildProjectDispatchStartedScopeDetails(context)
    );
  }

  async execute(context: ProjectDispatchLaunchContext): Promise<SessionDispatchResult> {
    const prepared = await this.operations.prepareProjectDispatchLaunch({
      dataRoot: this.context.dataRoot,
      project: context.input.project,
      paths: context.input.paths,
      session: context.input.session,
      providerId: context.providerId,
      taskId: context.input.taskId,
      messages: context.input.messages,
      allTasks: context.input.allTasks,
      rolePromptMap: context.input.rolePromptMap,
      roleSummaryMap: context.input.roleSummaryMap,
      registeredAgentIds: context.input.registeredAgentIds,
      startedAt: context.startedAt,
      dispatchId: context.dispatchId
    });
    if (context.providerId === "minimax") {
      return await runProjectMiniMaxDispatch(this.buildExecutionDependencies(), context, prepared);
    }
    return await runProjectSyncDispatch(this.buildExecutionDependencies(), context, prepared);
  }

  async onSuccess(
    _context: ProjectDispatchLaunchContext,
    result: SessionDispatchResult
  ): Promise<SessionDispatchResult> {
    return result;
  }

  async appendFailure(context: ProjectDispatchLaunchContext, error: unknown): Promise<void> {
    const reason = resolveOrchestratorErrorMessage(error);
    if (reason.includes("role.md")) {
      await this.context.repositories.events
        .appendEvent(context.input.paths, {
          projectId: context.input.project.projectId,
          eventType: "AGENT_ROLE_TEMPLATE_MISSING",
          source: "manager",
          sessionId: context.input.session.sessionId,
          taskId: context.input.taskId,
          payload: {
            role: context.input.session.role,
            reason
          }
        })
        .catch(() => {});
    }
    await this.eventAdapter
      .appendFailed(
        buildProjectDispatchEventScope(
          context.input.project,
          context.input.paths,
          context.input.session.sessionId,
          context.input.taskId || undefined
        ),
        {
          ...buildProjectDispatchStartedScopeDetails(context),
          error: reason
        }
      )
      .catch(() => {});
  }

  async onFailure(context: ProjectDispatchLaunchContext, error: unknown): Promise<SessionDispatchResult> {
    const reason = resolveOrchestratorErrorMessage(error);
    await this.operations.markRunnerFatalError({
      dataRoot: this.context.dataRoot,
      project: context.input.project,
      paths: context.input.paths,
      sessionId: context.input.session.sessionId,
      taskId: context.input.taskId,
      messageId: context.input.dispatchKind === "message" ? context.input.firstMessage.envelope.message_id : undefined,
      dispatchId: context.dispatchId,
      provider: context.providerId,
      error: reason
    });
    return {
      sessionId: context.input.session.sessionId,
      role: context.input.session.role,
      outcome: "dispatch_failed",
      dispatchKind: context.input.dispatchKind,
      reason,
      messageId: context.input.firstMessage.envelope.message_id,
      requestId: context.input.firstMessage.envelope.correlation.request_id,
      taskId: context.input.taskId
    };
  }

  private buildExecutionDependencies() {
    return {
      context: this.context,
      operations: this.operations,
      helpers: {
        buildProviderDispatchPayload: (
          context: ProjectDispatchLaunchContext,
          prepared: PreparedProjectDispatchLaunch,
          extra: Partial<ProviderProjectDispatchInput> = {}
        ) => buildProjectDispatchProviderPayload(context, prepared, extra),
        buildRunnerPayload: (context: ProjectDispatchLaunchContext, runId?: string, sessionId?: string) =>
          buildProjectDispatchRunnerScopePayload(this.context.dataRoot, context, runId, sessionId),
        appendTerminalDispatchEvent: (
          context: ProjectDispatchLaunchContext,
          sessionId: string,
          details: {
            dispatchFailedReason: string | null;
            runId: string;
            exitCode: number | null;
            timedOut: boolean;
            finishedAt: string;
          }
        ) =>
          appendProjectDispatchTerminalEventForContext(
            this.eventAdapter,
            this.context.repositories,
            context,
            sessionId,
            details
          ),
        markTaskDispatchedIfNeeded: (context: ProjectDispatchLaunchContext) =>
          markProjectTaskDispatchedForContextIfNeeded(this.context.repositories, context)
      }
    };
  }
}
