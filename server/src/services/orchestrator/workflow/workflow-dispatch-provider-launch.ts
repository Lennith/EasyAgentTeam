import fs from "node:fs/promises";
import type { ProviderRegistry } from "../../provider-runtime.js";
import { createWorkflowToolExecutionAdapter, DefaultToolInjector } from "../../tool-injector.js";
import { buildWorkflowDispatchPrompt } from "./workflow-dispatch-prompt.js";
import { buildWorkflowDispatchPromptContext } from "./workflow-dispatch-prompt-context.js";
import type {
  WorkflowDispatchLaunchAdapterContext,
  WorkflowDispatchLaunchContext
} from "./workflow-dispatch-launch-adapter.js";
import { appendWorkflowMaxTokensRecoveryEvent } from "./workflow-dispatch-run-lifecycle.js";
import {
  buildOrchestratorAgentWorkspaceDir,
  buildOrchestratorToolSessionInput,
  resolveOrchestratorManagerUrl,
  resolveOrchestratorProviderSessionId
} from "../shared/index.js";
import { createProviderCliUnavailableError } from "../../provider-launch-error.js";
import type { ProviderObservationEvent } from "../../provider-session-types.js";

export class WorkflowDispatchConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowDispatchConfigurationError";
  }
}

function resolveObservedProviderSessionId(event: ProviderObservationEvent): string {
  const providerSessionId = event.providerSessionId?.trim();
  return providerSessionId && providerSessionId.length > 0 ? providerSessionId : "";
}

async function persistWorkflowProviderSessionObservation(
  adapterContext: WorkflowDispatchLaunchAdapterContext,
  context: WorkflowDispatchLaunchContext,
  event: ProviderObservationEvent
): Promise<void> {
  if (event.providerId !== "codex" || event.kind !== "thread_started") {
    return;
  }
  const observedProviderSessionId = resolveObservedProviderSessionId(event);
  if (!observedProviderSessionId || observedProviderSessionId === context.lifecycleContext.providerSessionId) {
    return;
  }
  context.lifecycleContext.providerSessionId = observedProviderSessionId;
  await adapterContext.repositories.sessions
    .touchSession(context.input.run.runId, context.input.session.sessionId, {
      providerSessionId: observedProviderSessionId
    })
    .catch(() => {});
}

async function appendWorkflowProviderObservationEvent(
  adapterContext: WorkflowDispatchLaunchAdapterContext,
  context: WorkflowDispatchLaunchContext,
  event: ProviderObservationEvent
): Promise<void> {
  await persistWorkflowProviderSessionObservation(adapterContext, context, event);
  await adapterContext.repositories.events.appendEvent(context.input.run.runId, {
    eventType: "PROVIDER_OBSERVATION_RECORDED",
    source: "system",
    sessionId: context.input.session.sessionId,
    taskId: context.input.taskId ?? undefined,
    payload: {
      requestId: context.input.requestId,
      dispatchId: context.input.dispatchId,
      runId: context.input.run.runId,
      dispatchKind: context.input.dispatchKind,
      messageId: context.input.messageId ?? null,
      role: context.input.role,
      providerId: event.providerId,
      providerSessionId: resolveObservedProviderSessionId(event) || context.lifecycleContext.providerSessionId,
      step: event.step ?? null,
      kind: event.kind,
      details: event.details ?? {}
    }
  });
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
        model: context.prepared.model,
        reasoningEffort: context.prepared.reasoningEffort,
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
        codexTeamToolContext: toolInjection.codexTeamToolContext,
        callback: {
          onThinking: () => void adapterContext.touchSessionHeartbeat(runId, context.input.session.sessionId),
          onToolCall: () => void adapterContext.touchSessionHeartbeat(runId, context.input.session.sessionId),
          onToolResult: () => void adapterContext.touchSessionHeartbeat(runId, context.input.session.sessionId),
          onMessage: () => void adapterContext.touchSessionHeartbeat(runId, context.input.session.sessionId),
          onError: () => void adapterContext.touchSessionHeartbeat(runId, context.input.session.sessionId),
          onProviderObservation: async (event) => {
            await adapterContext.touchSessionHeartbeat(runId, context.input.session.sessionId);
            await appendWorkflowProviderObservationEvent(adapterContext, context, event);
          },
          onMaxTokensRecovery: async (event) => {
            await adapterContext.touchSessionHeartbeat(runId, context.input.session.sessionId);
            await appendWorkflowMaxTokensRecoveryEvent(adapterContext.repositories, context.lifecycleContext, event);
          }
        }
      }
    )
  );
}

export async function runWorkflowDispatchProviderLaunch(
  adapterContext: WorkflowDispatchLaunchAdapterContext,
  context: WorkflowDispatchLaunchContext
): Promise<Awaited<ReturnType<ProviderRegistry["runSessionWithTools"]>>> {
  const minimaxApiKey = context.prepared.settings.providers?.minimax.apiKey ?? context.prepared.settings.minimaxApiKey;
  const codexCliCommand =
    context.prepared.settings.providers?.codex.cliCommand ?? context.prepared.settings.codexCliCommand;
  if (context.prepared.providerId === "minimax" && !minimaxApiKey) {
    throw new WorkflowDispatchConfigurationError("minimax_not_configured");
  }
  if (context.prepared.providerId === "codex" && !codexCliCommand?.trim()) {
    throw createProviderCliUnavailableError("codex", "codex");
  }
  const runtime = await adapterContext.ensureRuntime(context.input.run);
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
  return await runWorkflowDispatchProviderSession(adapterContext, context, prompt);
}
