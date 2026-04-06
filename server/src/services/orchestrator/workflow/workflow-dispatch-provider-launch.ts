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

export class WorkflowDispatchConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowDispatchConfigurationError";
  }
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

export async function runWorkflowDispatchProviderLaunch(
  adapterContext: WorkflowDispatchLaunchAdapterContext,
  context: WorkflowDispatchLaunchContext
): Promise<Awaited<ReturnType<ProviderRegistry["runSessionWithTools"]>>> {
  if (context.prepared.providerId === "minimax" && !context.prepared.settings.minimaxApiKey) {
    throw new WorkflowDispatchConfigurationError("minimax_not_configured");
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
