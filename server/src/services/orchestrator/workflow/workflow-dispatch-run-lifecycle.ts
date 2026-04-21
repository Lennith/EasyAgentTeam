import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import type {
  WorkflowDispatchEventScope,
  WorkflowDispatchFailedDetails,
  WorkflowDispatchFinishedDetails,
  WorkflowDispatchStartedDetails
} from "./workflow-dispatch-event-adapter.js";
import {
  applyOrchestratorDispatchTerminalState,
  resolveOrchestratorErrorMessage,
  resolveRunnerFailureTransition
} from "../shared/index.js";
import { isProviderLaunchError } from "../../provider-launch-error.js";
import { getTransientErrorCooldownMs } from "../../session-lifecycle-authority.js";

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
  sessionId?: string | null;
  providerSessionId?: string | null;
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

export function buildWorkflowDispatchEventScope(context: WorkflowDispatchLifecycleContext): WorkflowDispatchEventScope {
  return {
    runId: context.runId,
    sessionId: context.sessionId,
    taskId: context.taskId ?? undefined
  };
}

export function buildWorkflowDispatchStartedDetails(
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
  const transition = resolveRunnerFailureTransition({
    kind: "config",
    run_id: context.runId,
    dispatch_id: context.dispatchId,
    dispatch_kind: context.dispatchKind,
    message_id: context.messageId ?? null,
    error: "minimax_not_configured",
    code: null,
    next_action: "Configure MiniMax API settings, then retry the same task/message dispatch.",
    current_task_id: context.taskId,
    preserve_current_task_id: true,
    existing_error_streak: context.errorStreak
  });
  await dependencies.eventAdapter.appendFailed(buildWorkflowDispatchEventScope(context), {
    requestId: context.requestId,
    dispatchId: context.dispatchId,
    dispatchKind: context.dispatchKind,
    messageId: context.messageId ?? null,
    requestedSkillIds: context.requestedSkillIds,
    error: "minimax_not_configured"
  });
  await dependencies.repositories.sessions.touchSession(context.runId, context.sessionId, {
    status: transition.session_patch.status,
    currentTaskId: transition.session_patch.currentTaskId ?? context.taskId,
    errorStreak: transition.session_patch.errorStreak,
    lastFailureAt: transition.session_patch.lastFailureAt,
    lastFailureKind: transition.session_patch.lastFailureKind,
    lastFailureDispatchId: context.dispatchId,
    lastFailureMessageId: context.messageId ?? null,
    lastFailureTaskId: transition.session_patch.currentTaskId ?? context.taskId,
    cooldownUntil: transition.session_patch.cooldownUntil,
    agentPid: null,
    lastRunId: context.runId
  });
  const failureEvent = await dependencies.repositories.events.appendEvent(context.runId, {
    eventType: transition.event_type,
    source: "system",
    sessionId: context.sessionId,
    taskId: context.taskId ?? undefined,
    payload: {
      request_id: context.requestId,
      ...transition.event_payload
    }
  });
  await dependencies.repositories.sessions.touchSession(context.runId, context.sessionId, {
    lastFailureEventId: failureEvent.eventId
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
  const resolvedProviderSessionId =
    dispatchRunResult.providerSessionId ?? dispatchRunResult.sessionId ?? context.providerSessionId;
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
    providerSessionId: resolvedProviderSessionId,
    timeoutStreak: 0,
    errorStreak: 0,
    lastFailureAt: null,
    lastFailureKind: null,
    lastFailureEventId: null,
    lastFailureDispatchId: null,
    lastFailureMessageId: null,
    lastFailureTaskId: null,
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
  const providerError = isProviderLaunchError(error) ? error : null;
  const failureMessage = providerError?.message ?? reason;
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
        error: failureMessage
      });
    }
  );

  if (dispatchTerminalState.timedOut) {
    return;
  }

  const latestSession = await dependencies.repositories.sessions.getSession(context.runId, context.sessionId);
  const blockedByConfig = providerError?.category === "config";
  const transientProviderError =
    providerError?.retryable && providerError.code === "PROVIDER_UPSTREAM_TRANSIENT_ERROR" ? providerError : null;
  const transition = blockedByConfig
    ? resolveRunnerFailureTransition({
        kind: "config",
        run_id: context.runId,
        dispatch_id: context.dispatchId,
        dispatch_kind: context.dispatchKind,
        message_id: context.messageId ?? null,
        error: failureMessage,
        code: providerError?.code ?? null,
        next_action: providerError?.nextAction ?? null,
        raw_status: (providerError?.details?.status as number | string | null | undefined) ?? null,
        current_task_id: context.taskId,
        preserve_current_task_id: false,
        existing_error_streak: latestSession?.errorStreak ?? context.errorStreak
      })
    : transientProviderError
      ? resolveRunnerFailureTransition({
          kind: "transient",
          run_id: context.runId,
          dispatch_id: context.dispatchId,
          dispatch_kind: context.dispatchKind,
          message_id: context.messageId ?? null,
          error: transientProviderError.message,
          code: transientProviderError.code,
          next_action: transientProviderError.nextAction,
          raw_status: (transientProviderError.details?.status as number | string | null | undefined) ?? null,
          current_task_id: context.taskId,
          preserve_current_task_id: true,
          existing_error_streak: latestSession?.errorStreak ?? context.errorStreak,
          transient_cooldown_ms: getTransientErrorCooldownMs()
        })
      : resolveRunnerFailureTransition({
          kind: "generic",
          run_id: context.runId,
          dispatch_id: context.dispatchId,
          dispatch_kind: context.dispatchKind,
          message_id: context.messageId ?? null,
          error: failureMessage,
          code: providerError?.code ?? null,
          next_action: providerError?.nextAction ?? null,
          raw_status: (providerError?.details?.status as number | string | null | undefined) ?? null,
          current_task_id: context.taskId,
          preserve_current_task_id: false,
          existing_error_streak: latestSession?.errorStreak ?? context.errorStreak,
          generic_runtime_strategy: {
            session_status: "dismissed",
            event_type: "RUNNER_FATAL_ERROR_DISMISSED",
            retryable: false
          }
        });

  await dependencies.repositories.sessions
    .touchSession(context.runId, context.sessionId, {
      status: transition.session_patch.status,
      ...(transition.session_patch.currentTaskId !== undefined
        ? { currentTaskId: transition.session_patch.currentTaskId }
        : {}),
      errorStreak: transition.session_patch.errorStreak,
      lastFailureAt: transition.session_patch.lastFailureAt,
      lastFailureKind: transition.session_patch.lastFailureKind,
      lastFailureDispatchId: context.dispatchId,
      lastFailureMessageId: context.messageId ?? null,
      lastFailureTaskId: transition.session_patch.currentTaskId ?? context.taskId,
      cooldownUntil: transition.session_patch.cooldownUntil,
      agentPid: null,
      lastRunId: context.runId
    })
    .catch(() => {});
  const failureEvent = await dependencies.repositories.events
    .appendEvent(context.runId, {
      eventType: transition.event_type,
      source: "system",
      sessionId: context.sessionId,
      taskId: context.taskId ?? undefined,
      payload: {
        request_id: context.requestId,
        ...transition.event_payload
      }
    })
    .catch(() => {});
  if (failureEvent) {
    await dependencies.repositories.sessions
      .touchSession(context.runId, context.sessionId, {
        lastFailureEventId: failureEvent.eventId
      })
      .catch(() => {});
  }
}
