import fs from "node:fs/promises";
import type { WorkflowRepositoryBundle } from "../../data/repository/workflow-repository-bundle.js";
import type {
  WorkflowManagerToAgentMessage,
  WorkflowRunRecord,
  WorkflowRunRuntimeState,
  WorkflowSessionRecord,
  WorkflowTaskActionRequest,
  WorkflowTaskActionResult
} from "../../domain/models.js";
import type { ProviderRegistry } from "../provider-runtime.js";
import { createWorkflowToolExecutionAdapter, DefaultToolInjector } from "../tool-injector.js";
import { buildWorkflowDispatchPrompt } from "./workflow-dispatch-prompt.js";
import { buildWorkflowDispatchPromptContext } from "./workflow-dispatch-prompt-context.js";
import {
  WorkflowDispatchEventAdapter,
  type WorkflowDispatchEventScope,
  type WorkflowDispatchFailedDetails,
  type WorkflowDispatchFinishedDetails,
  type WorkflowDispatchStartedDetails
} from "./workflow-dispatch-event-adapter.js";
import type { WorkflowRouteMessageInput } from "./workflow-message-routing-service.js";
import {
  defaultWorkflowDispatchLaunchPreparationOperations,
  prepareWorkflowDispatchLaunch,
  type PreparedWorkflowDispatchLaunch,
  type WorkflowDispatchLaunchPreparationOperations
} from "./workflow-dispatch-launch-preparation.js";
import {
  applyOrchestratorDispatchTerminalState,
  buildOrchestratorAgentWorkspaceDir,
  buildOrchestratorToolSessionInput,
  resolveOrchestratorErrorMessage,
  resolveOrchestratorManagerUrl,
  resolveOrchestratorProviderSessionId,
  executeOrchestratorLaunch,
  type OrchestratorDispatchLaunchAdapter,
  type OrchestratorLaunchExecutionAdapter
} from "./shared/index.js";

class WorkflowDispatchConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowDispatchConfigurationError";
  }
}

type WorkflowDispatchEventWriter = {
  appendStarted(scope: WorkflowDispatchEventScope, details: WorkflowDispatchStartedDetails): Promise<void>;
  appendFinished(scope: WorkflowDispatchEventScope, details: WorkflowDispatchFinishedDetails): Promise<void>;
  appendFailed(scope: WorkflowDispatchEventScope, details: WorkflowDispatchFailedDetails): Promise<void>;
};

export interface WorkflowDispatchLifecycleContext {
  runId: string;
  sessionId: string;
  taskId: string | null;
  requestId: string;
  dispatchId: string;
  dispatchKind: "task" | "message";
  messageId?: string | null;
  requestedSkillIds: string[];
  tokenLimit: number;
  maxOutputTokens: number;
  providerSessionId: string;
  errorStreak: number;
}

export interface WorkflowDispatchRunResultMeta {
  finishReason?: string | null;
  usage?: unknown;
  maxOutputTokens?: number;
  tokenLimit?: number;
  maxTokensRecoveryAttempt?: number;
  maxTokensSnapshotPath?: string | null;
  recoveredFromMaxTokens?: boolean;
}

export interface WorkflowMaxTokensRecoveryEvent {
  observedAt: string;
  step: number;
  attempt: number;
  maxAttempts: number;
  recovered: boolean;
  finishReason: "max_tokens";
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  preCompressMessageCount: number;
  preCompressChars: number;
  postCompressMessageCount: number;
  postCompressChars: number;
  compactedToolCallChains: number;
  compactedToolMessages: number;
  compressionMode: "llm_compressor" | "deterministic_trim" | "none";
  compressionError?: string;
  continuationInjected: boolean;
  maxTokensSnapshotPath?: string | null;
}

interface WorkflowDispatchLifecycleDependencies {
  repositories: WorkflowRepositoryBundle;
  eventAdapter: WorkflowDispatchEventWriter;
}

function buildWorkflowDispatchEventScope(context: WorkflowDispatchLifecycleContext): WorkflowDispatchEventScope {
  return {
    runId: context.runId,
    sessionId: context.sessionId,
    taskId: context.taskId ?? undefined
  };
}

function buildWorkflowDispatchStartedDetails(
  context: WorkflowDispatchLifecycleContext
): WorkflowDispatchStartedDetails {
  return {
    requestId: context.requestId,
    dispatchId: context.dispatchId,
    dispatchKind: context.dispatchKind,
    messageId: context.messageId ?? null,
    requestedSkillIds: context.requestedSkillIds,
    tokenLimit: context.tokenLimit,
    maxOutputTokens: context.maxOutputTokens
  };
}

export async function handleMissingWorkflowMiniMaxConfiguration(
  dependencies: WorkflowDispatchLifecycleDependencies,
  context: WorkflowDispatchLifecycleContext
): Promise<void> {
  await dependencies.eventAdapter.appendFailed(buildWorkflowDispatchEventScope(context), {
    requestId: context.requestId,
    dispatchId: context.dispatchId,
    dispatchKind: context.dispatchKind,
    messageId: context.messageId ?? null,
    requestedSkillIds: context.requestedSkillIds,
    error: "minimax_not_configured"
  });
  await dependencies.repositories.sessions.touchSession(context.runId, context.sessionId, {
    status: "dismissed",
    errorStreak: context.errorStreak + 1,
    lastFailureAt: new Date().toISOString(),
    lastFailureKind: "error",
    cooldownUntil: null,
    agentPid: null
  });
}

export async function appendWorkflowMaxTokensRecoveryEvent(
  repositories: WorkflowRepositoryBundle,
  context: WorkflowDispatchLifecycleContext,
  event: WorkflowMaxTokensRecoveryEvent
): Promise<void> {
  await repositories.events.appendEvent(context.runId, {
    eventType: "MINIMAX_MAX_TOKENS_RECOVERY",
    source: "system",
    sessionId: context.sessionId,
    taskId: context.taskId ?? undefined,
    payload: {
      requestId: context.requestId,
      dispatchId: context.dispatchId,
      runId: context.runId,
      dispatchKind: context.dispatchKind,
      messageId: context.messageId ?? null,
      tokenLimit: context.tokenLimit,
      maxOutputTokens: context.maxOutputTokens,
      ...event
    }
  });
}

export async function handleWorkflowDispatchLaunchResult(
  dependencies: WorkflowDispatchLifecycleDependencies,
  context: WorkflowDispatchLifecycleContext,
  dispatchRunResult: WorkflowDispatchRunResultMeta
): Promise<void> {
  const dispatchTerminalState = await applyOrchestratorDispatchTerminalState(
    async () => await dependencies.repositories.events.listEvents(context.runId),
    context.sessionId,
    context.dispatchId,
    async (terminalState) => {
      if (!terminalState.timedOut) {
        return;
      }
      await dependencies.eventAdapter.appendFinished(buildWorkflowDispatchEventScope(context), {
        requestId: context.requestId,
        dispatchId: context.dispatchId,
        dispatchKind: context.dispatchKind,
        messageId: context.messageId ?? null,
        requestedSkillIds: context.requestedSkillIds,
        exitCode: null,
        timedOut: true,
        synthetic: true,
        reason: "dispatch_timed_out_before_finish",
        finishReason: dispatchRunResult.finishReason ?? null,
        usage: dispatchRunResult.usage ?? null,
        maxOutputTokens: dispatchRunResult.maxOutputTokens ?? context.maxOutputTokens,
        tokenLimit: dispatchRunResult.tokenLimit ?? context.tokenLimit,
        maxTokensRecoveryAttempt: dispatchRunResult.maxTokensRecoveryAttempt ?? 0,
        maxTokensSnapshotPath: dispatchRunResult.maxTokensSnapshotPath ?? null,
        recoveredFromMaxTokens: dispatchRunResult.recoveredFromMaxTokens ?? false
      });
    }
  );
  if (dispatchTerminalState.timedOut || dispatchTerminalState.closed) {
    return;
  }

  await dependencies.repositories.sessions.touchSession(context.runId, context.sessionId, {
    status: "idle",
    currentTaskId: null,
    providerSessionId: context.providerSessionId,
    timeoutStreak: 0,
    errorStreak: 0,
    lastFailureAt: null,
    lastFailureKind: null,
    cooldownUntil: null,
    lastRunId: context.runId
  });
  await dependencies.eventAdapter.appendFinished(buildWorkflowDispatchEventScope(context), {
    requestId: context.requestId,
    dispatchId: context.dispatchId,
    dispatchKind: context.dispatchKind,
    messageId: context.messageId ?? null,
    requestedSkillIds: context.requestedSkillIds,
    finishReason: dispatchRunResult.finishReason ?? null,
    usage: dispatchRunResult.usage ?? null,
    maxOutputTokens: dispatchRunResult.maxOutputTokens ?? context.maxOutputTokens,
    tokenLimit: dispatchRunResult.tokenLimit ?? context.tokenLimit,
    maxTokensRecoveryAttempt: dispatchRunResult.maxTokensRecoveryAttempt ?? 0,
    maxTokensSnapshotPath: dispatchRunResult.maxTokensSnapshotPath ?? null,
    recoveredFromMaxTokens: dispatchRunResult.recoveredFromMaxTokens ?? false
  });
}

export async function handleWorkflowDispatchLaunchError(
  dependencies: WorkflowDispatchLifecycleDependencies,
  context: WorkflowDispatchLifecycleContext,
  error: unknown
): Promise<void> {
  const reason = resolveOrchestratorErrorMessage(error);
  const dispatchTerminalState = await applyOrchestratorDispatchTerminalState(
    async () => await dependencies.repositories.events.listEvents(context.runId),
    context.sessionId,
    context.dispatchId,
    async (terminalState) => {
      if (terminalState.timedOut) {
        return;
      }
      await dependencies.eventAdapter.appendFailed(buildWorkflowDispatchEventScope(context), {
        requestId: context.requestId,
        dispatchId: context.dispatchId,
        dispatchKind: context.dispatchKind,
        messageId: context.messageId ?? null,
        requestedSkillIds: context.requestedSkillIds,
        error: reason
      });
    }
  );

  if (dispatchTerminalState.timedOut) {
    return;
  }

  const latestSession = await dependencies.repositories.sessions.getSession(context.runId, context.sessionId);
  await dependencies.repositories.sessions
    .touchSession(context.runId, context.sessionId, {
      status: "dismissed",
      errorStreak: (latestSession?.errorStreak ?? 0) + 1,
      lastFailureAt: new Date().toISOString(),
      lastFailureKind: "error",
      cooldownUntil: null,
      agentPid: null,
      lastRunId: context.runId
    })
    .catch(() => {});
}

async function runWorkflowDispatchProviderSession(
  adapterContext: WorkflowDispatchLaunchAdapterContext,
  context: WorkflowDispatchLaunchContext,
  prompt: string
): Promise<Awaited<ReturnType<ProviderRegistry["runSessionWithTools"]>>> {
  const runId = context.input.run.runId;
  const agentWorkspaceDir = buildOrchestratorAgentWorkspaceDir(context.input.run.workspacePath, context.input.role);
  await fs.mkdir(agentWorkspaceDir, { recursive: true });
  const providerSessionId = resolveOrchestratorProviderSessionId(
    context.input.session.sessionId,
    context.input.session.providerSessionId
  );
  const toolInjection = DefaultToolInjector.build(
    createWorkflowToolExecutionAdapter({
      dataRoot: adapterContext.dataRoot,
      run: context.input.run,
      agentRole: context.input.role,
      sessionId: context.input.session.sessionId,
      activeTaskId: context.input.taskId ?? undefined,
      activeRequestId: context.input.requestId,
      parentRequestId: context.input.requestId,
      applyTaskAction: async (request) =>
        (await adapterContext.applyTaskActions(runId, request)) as unknown as Record<string, unknown>,
      sendRunMessage: async (request) =>
        (await adapterContext.sendRunMessage({ runId, ...request })) as unknown as Record<string, unknown>
    })
  );

  return await adapterContext.providerRegistry.runSessionWithTools(
    context.prepared.providerId,
    context.prepared.settings,
    buildOrchestratorToolSessionInput(
      {
        prompt,
        sessionId: context.input.session.sessionId,
        providerSessionId,
        workspaceDir: agentWorkspaceDir,
        workspaceRoot: context.input.run.workspacePath,
        role: context.input.role,
        rolePrompt: context.prepared.rolePrompt,
        skillIds: context.prepared.requestedSkillIds,
        skillSegments: context.prepared.importedSkillPrompt.segments,
        contextKind: "workflow_dispatch",
        contextOverride: context.input.taskId ? `Active task: ${context.input.taskId}` : undefined,
        runtimeConstraints: ["Report phase completion via TASK_REPORT on the phase task."],
        apiBaseFallback: "https://api.minimax.io",
        modelFallback: "MiniMax-M2.5-High-speed",
        env: {
          AUTO_DEV_WORKFLOW_RUN_ID: runId,
          AUTO_DEV_SESSION_ID: context.input.session.sessionId,
          AUTO_DEV_AGENT_ROLE: context.input.role,
          AUTO_DEV_WORKFLOW_ROOT: context.input.run.workspacePath,
          AUTO_DEV_AGENT_WORKSPACE: agentWorkspaceDir,
          AUTO_DEV_MANAGER_URL: resolveOrchestratorManagerUrl()
        }
      },
      {
        teamToolContext: toolInjection.teamToolContext,
        teamToolBridge: toolInjection.teamToolBridge,
        callback: {
          onThinking: () => void adapterContext.touchSessionHeartbeat(runId, context.input.session.sessionId),
          onToolCall: () => void adapterContext.touchSessionHeartbeat(runId, context.input.session.sessionId),
          onToolResult: () => void adapterContext.touchSessionHeartbeat(runId, context.input.session.sessionId),
          onMessage: () => void adapterContext.touchSessionHeartbeat(runId, context.input.session.sessionId),
          onError: () => void adapterContext.touchSessionHeartbeat(runId, context.input.session.sessionId),
          onMaxTokensRecovery: async (event) => {
            await adapterContext.touchSessionHeartbeat(runId, context.input.session.sessionId);
            await appendWorkflowMaxTokensRecoveryEvent(adapterContext.repositories, context.lifecycleContext, event);
          }
        }
      }
    )
  );
}

export interface WorkflowDispatchLaunchContext {
  input: WorkflowDispatchLaunchInput;
  prepared: PreparedWorkflowDispatchLaunch;
  lifecycleContext: WorkflowDispatchLifecycleContext;
}

export interface WorkflowDispatchLaunchInput {
  run: WorkflowRunRecord;
  session: WorkflowSessionRecord;
  role: string;
  dispatchKind: "task" | "message";
  taskId: string | null;
  message: WorkflowManagerToAgentMessage | null;
  requestId: string;
  messageId?: string;
  dispatchId: string;
}

export interface WorkflowDispatchLaunchAdapterContext {
  dataRoot: string;
  providerRegistry: ProviderRegistry;
  repositories: WorkflowRepositoryBundle;
  touchSessionHeartbeat(runId: string, sessionId: string): Promise<void>;
  ensureRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState>;
  applyTaskActions(
    runId: string,
    input: WorkflowTaskActionRequest
  ): Promise<Omit<WorkflowTaskActionResult, "requestId">>;
  sendRunMessage(input: WorkflowRouteMessageInput): Promise<unknown>;
  eventAdapter?: WorkflowDispatchEventAdapter;
}

export class WorkflowDispatchLaunchAdapter
  implements
    OrchestratorDispatchLaunchAdapter<WorkflowDispatchLaunchInput, void>,
    OrchestratorLaunchExecutionAdapter<
      WorkflowDispatchLaunchInput,
      WorkflowDispatchLaunchContext,
      Awaited<ReturnType<ProviderRegistry["runSessionWithTools"]>>,
      void
    >
{
  private readonly eventAdapter: WorkflowDispatchEventAdapter;

  constructor(
    private readonly context: WorkflowDispatchLaunchAdapterContext,
    private readonly operations: WorkflowDispatchLaunchPreparationOperations = defaultWorkflowDispatchLaunchPreparationOperations
  ) {
    this.eventAdapter = context.eventAdapter ?? new WorkflowDispatchEventAdapter(context.repositories);
  }

  async launch(input: WorkflowDispatchLaunchInput): Promise<void> {
    await executeOrchestratorLaunch(input, this);
  }

  async createContext(input: WorkflowDispatchLaunchInput): Promise<WorkflowDispatchLaunchContext> {
    const prepared = await prepareWorkflowDispatchLaunch(
      {
        dataRoot: this.context.dataRoot,
        run: input.run,
        role: input.role,
        session: input.session
      },
      this.operations
    );
    return {
      input,
      prepared,
      lifecycleContext: {
        runId: input.run.runId,
        sessionId: input.session.sessionId,
        taskId: input.taskId,
        requestId: input.requestId,
        dispatchId: input.dispatchId,
        dispatchKind: input.dispatchKind,
        messageId: input.messageId ?? null,
        requestedSkillIds: prepared.requestedSkillIds,
        tokenLimit: prepared.tokenLimit,
        maxOutputTokens: prepared.maxOutputTokens,
        providerSessionId: resolveOrchestratorProviderSessionId(
          input.session.sessionId,
          input.session.providerSessionId
        ),
        errorStreak: input.session.errorStreak ?? 0
      }
    };
  }

  async appendStarted(context: WorkflowDispatchLaunchContext): Promise<void> {
    await this.eventAdapter.appendStarted(
      buildWorkflowDispatchEventScope(context.lifecycleContext),
      buildWorkflowDispatchStartedDetails(context.lifecycleContext)
    );
  }

  async appendSuccess(
    context: WorkflowDispatchLaunchContext,
    dispatchRunResult: Awaited<ReturnType<ProviderRegistry["runSessionWithTools"]>>
  ): Promise<void> {
    await handleWorkflowDispatchLaunchResult(
      {
        repositories: this.context.repositories,
        eventAdapter: this.eventAdapter
      },
      context.lifecycleContext,
      dispatchRunResult
    );
  }

  async execute(context: WorkflowDispatchLaunchContext) {
    if (context.prepared.providerId === "minimax" && !context.prepared.settings.minimaxApiKey) {
      throw new WorkflowDispatchConfigurationError("minimax_not_configured");
    }
    const runtime = await this.context.ensureRuntime(context.input.run);
    const runtimeTask = context.input.taskId
      ? (runtime.tasks.find((item) => item.taskId === context.input.taskId) ?? null)
      : null;
    const promptContext = buildWorkflowDispatchPromptContext({
      run: context.input.run,
      role: context.input.role,
      taskId: context.input.taskId,
      dispatchKind: context.input.dispatchKind,
      message: context.input.message,
      taskState: runtimeTask?.state ?? null,
      runtimeTasks: runtime.tasks,
      rolePrompt: context.prepared.rolePrompt
    });
    const prompt = buildWorkflowDispatchPrompt(promptContext);
    return await runWorkflowDispatchProviderSession(this.context, context, prompt);
  }

  async onSuccess(
    _context: WorkflowDispatchLaunchContext,
    _dispatchRunResult: Awaited<ReturnType<ProviderRegistry["runSessionWithTools"]>>
  ): Promise<void> {
    return;
  }

  async appendFailure(context: WorkflowDispatchLaunchContext, error: unknown): Promise<void> {
    if (error instanceof WorkflowDispatchConfigurationError && error.message === "minimax_not_configured") {
      await handleMissingWorkflowMiniMaxConfiguration(
        {
          repositories: this.context.repositories,
          eventAdapter: this.eventAdapter
        },
        context.lifecycleContext
      );
      return;
    }
    await handleWorkflowDispatchLaunchError(
      {
        repositories: this.context.repositories,
        eventAdapter: this.eventAdapter
      },
      context.lifecycleContext,
      error
    );
  }

  async onFailure(_context: WorkflowDispatchLaunchContext, _error: unknown): Promise<void> {
    return;
  }
}
