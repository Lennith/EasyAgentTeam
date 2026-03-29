import fs from "node:fs/promises";
import type { ProviderRegistry } from "../provider-runtime.js";
import { createWorkflowToolExecutionAdapter, DefaultToolInjector } from "../tool-injector.js";
import type { WorkflowRepositoryBundle } from "../../data/repository/workflow-repository-bundle.js";
import type {
  WorkflowDispatchEventScope,
  WorkflowDispatchFailedDetails,
  WorkflowDispatchFinishedDetails,
  WorkflowDispatchStartedDetails
} from "./workflow-dispatch-event-adapter.js";
import { isOrchestratorDispatchClosed, wasOrchestratorDispatchTimedOut } from "./shared/dispatch-lifecycle.js";
import {
  buildOrchestratorAgentWorkspaceDir,
  buildOrchestratorToolSessionInput,
  resolveOrchestratorManagerUrl,
  resolveOrchestratorProviderSessionId
} from "./shared/index.js";
import type {
  WorkflowDispatchLaunchAdapterContext,
  WorkflowDispatchLaunchContext
} from "./workflow-dispatch-launch-adapter.js";

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

export async function runWorkflowDispatchProviderSession(
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
  const dispatchEvents = await dependencies.repositories.events.listEvents(context.runId);
  const dispatchTimedOut = wasOrchestratorDispatchTimedOut(dispatchEvents, context.sessionId, context.dispatchId);
  const dispatchClosed = isOrchestratorDispatchClosed(dispatchEvents, context.dispatchId);
  if (dispatchTimedOut) {
    if (!dispatchClosed) {
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
    return;
  }

  if (dispatchClosed) {
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
  const reason = error instanceof Error ? error.message : String(error);
  const dispatchEvents = await dependencies.repositories.events.listEvents(context.runId);
  const dispatchTimedOut = wasOrchestratorDispatchTimedOut(dispatchEvents, context.sessionId, context.dispatchId);
  const dispatchClosed = isOrchestratorDispatchClosed(dispatchEvents, context.dispatchId);
  if (!dispatchClosed && !dispatchTimedOut) {
    await dependencies.eventAdapter.appendFailed(buildWorkflowDispatchEventScope(context), {
      requestId: context.requestId,
      dispatchId: context.dispatchId,
      dispatchKind: context.dispatchKind,
      messageId: context.messageId ?? null,
      requestedSkillIds: context.requestedSkillIds,
      error: reason
    });
  }

  if (dispatchTimedOut) {
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

function buildWorkflowDispatchEventScope(context: WorkflowDispatchLifecycleContext): WorkflowDispatchEventScope {
  return {
    runId: context.runId,
    sessionId: context.sessionId,
    taskId: context.taskId ?? undefined
  };
}
