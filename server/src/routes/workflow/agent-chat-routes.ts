import type express from "express";
import { randomUUID } from "node:crypto";
import type { ProviderId } from "@autodev/agent-library";
import {
  buildOrchestratorAgentWorkspaceDir,
  buildOrchestratorMinimaxSessionDir,
  resolveOrchestratorManagerUrl,
  resolveOrchestratorProviderSessionId
} from "../../services/orchestrator/shared/index.js";
import { resolveSessionProviderId } from "../../services/provider-runtime.js";
import { createWorkflowToolExecutionAdapter, DefaultToolInjector } from "../../services/tool-injector.js";
import {
  streamAgentChat,
  resolveAgentPromptBundle,
  resolveRuntimeSettings
} from "../../services/agent-chat-service.js";
import { readWorkflowRunForApi } from "../../services/workflow-admin-service.js";
import type { AppRuntimeContext } from "../shared/context.js";
import { readProviderIdField, sendApiError } from "../shared/http.js";

export function registerWorkflowAgentChatRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot, providerRegistry, workflowOrchestrator } = context;

  app.post("/api/workflow-runs/:run_id/agent-chat", async (req, res, next) => {
    const runId = req.params.run_id;
    const body = req.body as Record<string, unknown>;
    const role = (body.role as string)?.trim();
    const prompt = (body.prompt as string)?.trim();
    const sessionId = (body.sessionId as string)?.trim();
    const providerSessionId = (body.providerSessionId as string)?.trim();

    if (!role) {
      sendApiError(res, 400, "ROLE_REQUIRED", "role is required", "Provide the agent role to chat with.");
      return;
    }
    if (!prompt) {
      sendApiError(res, 400, "PROMPT_REQUIRED", "prompt is required", "Provide the message to send to the agent.");
      return;
    }

    try {
      await streamAgentChat(
        res,
        providerRegistry,
        {
          resolve: async (input) => {
            const run = await readWorkflowRunForApi(dataRoot, runId);
            if (!run) {
              throw new Error(`workflow run '${runId}' not found`);
            }
            const settings = await resolveRuntimeSettings(dataRoot);
            const providerId = resolveSessionProviderId(run, input.role, "minimax");
            const promptBundle = await resolveAgentPromptBundle(dataRoot, input.role);
            const chatSessionId = input.sessionId || `wf-agent-chat-${Date.now()}-${randomUUID().slice(0, 8)}`;
            const agentWorkspaceDir = buildOrchestratorAgentWorkspaceDir(run.workspacePath, input.role);
            const toolInjection = DefaultToolInjector.build(
              createWorkflowToolExecutionAdapter({
                dataRoot,
                run,
                agentRole: input.role,
                sessionId: chatSessionId,
                applyTaskAction: async (request) =>
                  (await workflowOrchestrator.applyTaskActions(runId, request)) as unknown as Record<string, unknown>,
                sendRunMessage: async (request) =>
                  (await workflowOrchestrator.sendRunMessage({ runId, ...request })) as unknown as Record<
                    string,
                    unknown
                  >
              })
            );
            return {
              providerId,
              settings,
              sessionId: chatSessionId,
              providerSessionId: resolveOrchestratorProviderSessionId(chatSessionId, input.providerSessionId),
              workspaceDir: agentWorkspaceDir,
              workspaceRoot: run.workspacePath,
              role: input.role,
              prompt: input.prompt,
              rolePrompt: promptBundle.rolePrompt,
              skillSegments: promptBundle.skillSegments,
              skillIds: promptBundle.skillIds,
              contextKind: "workflow_agent_chat",
              runtimeConstraints: ["Use TASK_CREATE/TASK_DISCUSS_*/TASK_REPORT through TeamTools APIs."],
              sessionDirFallback: buildOrchestratorMinimaxSessionDir(run.workspacePath),
              apiBaseFallback: "https://api.minimax.io/v1",
              modelFallback: "MiniMax-Text-01",
              env: {
                AUTO_DEV_WORKFLOW_RUN_ID: runId,
                AUTO_DEV_SESSION_ID: chatSessionId,
                AUTO_DEV_AGENT_ROLE: input.role,
                AUTO_DEV_WORKFLOW_ROOT: run.workspacePath,
                AUTO_DEV_AGENT_WORKSPACE: agentWorkspaceDir,
                AUTO_DEV_MANAGER_URL: resolveOrchestratorManagerUrl()
              },
              toolInjection
            };
          }
        },
        { role, prompt, sessionId, providerSessionId }
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/workflow-runs/:run_id/agent-chat/:sessionId/interrupt", async (req, res, next) => {
    const sessionId = req.params.sessionId;
    try {
      const body = req.body as Record<string, unknown>;
      const preferredProviderId = readProviderIdField(body, "provider_id", "minimax");
      const providerCandidates: ProviderId[] = Array.from(new Set([preferredProviderId, "minimax", "codex"]));
      let cancelled = false;
      for (const providerId of providerCandidates) {
        if (providerRegistry.cancelSession(providerId, sessionId)) {
          cancelled = true;
          break;
        }
      }
      res.json({ success: true, cancelled });
    } catch (error) {
      next(error);
    }
  });
}
