import type express from "express";
import type { ProviderId } from "@autodev/agent-library";
import { getRuntimeSettings, type RuntimeSettings } from "../data/repository/system/runtime-settings-repository.js";
import type { ProviderRegistry } from "./provider-runtime.js";
import {
  buildOrchestratorToolSessionInput,
  resolveOrchestratorRolePromptSkillBundle
} from "./orchestrator/shared/index.js";
import type { ToolInjectionPayload } from "./tool-injector.js";

export interface AgentChatRequestInput {
  role: string;
  prompt: string;
  sessionId?: string;
  providerSessionId?: string;
}

export interface AgentPromptBundle {
  rolePrompt?: string;
  skillIds: string[];
  skillSegments: string[];
}

export interface ExecutionContext {
  providerId: ProviderId;
  settings: RuntimeSettings;
  sessionId: string;
  providerSessionId?: string;
  workspaceDir: string;
  workspaceRoot: string;
  role: string;
  prompt: string;
  rolePrompt?: string;
  skillSegments: string[];
  skillIds: string[];
  contextKind: string;
  runtimeConstraints: string[];
  sessionDirFallback: string;
  apiBaseFallback: string;
  modelFallback: string;
  env: Record<string, string>;
  toolInjection?: ToolInjectionPayload;
}

export interface AgentChatContextAdapter {
  resolve(input: AgentChatRequestInput): Promise<ExecutionContext>;
}

export async function resolveAgentPromptBundle(dataRoot: string, role: string): Promise<AgentPromptBundle> {
  const bundle = await resolveOrchestratorRolePromptSkillBundle({
    dataRoot,
    role
  });
  return {
    rolePrompt: bundle.rolePrompt,
    skillIds: bundle.skillIds,
    skillSegments: bundle.skillSegments
  };
}

export async function resolveRuntimeSettings(dataRoot: string): Promise<RuntimeSettings> {
  return getRuntimeSettings(dataRoot);
}

export function initializeSse(response: express.Response): (event: string, data: unknown) => void {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  return (event: string, data: unknown) => {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

export async function streamAgentChat(
  response: express.Response,
  providerRegistry: ProviderRegistry,
  adapter: AgentChatContextAdapter,
  input: AgentChatRequestInput
): Promise<void> {
  const sendEvent = initializeSse(response);

  try {
    const execution = await adapter.resolve(input);
    sendEvent("session", {
      sessionId: execution.sessionId,
      providerSessionId: execution.providerSessionId
    });

    await providerRegistry.runSessionWithTools(execution.providerId, execution.settings, {
      ...buildOrchestratorToolSessionInput({
        prompt: execution.prompt,
        sessionId: execution.sessionId,
        providerSessionId: execution.providerSessionId,
        workspaceDir: execution.workspaceDir,
        workspaceRoot: execution.workspaceRoot,
        role: execution.role,
        rolePrompt: execution.rolePrompt,
        skillSegments: execution.skillSegments,
        skillIds: execution.skillIds,
        contextKind: execution.contextKind,
        runtimeConstraints: execution.runtimeConstraints,
        sessionDirFallback: execution.sessionDirFallback,
        apiBaseFallback: execution.apiBaseFallback,
        modelFallback: execution.modelFallback,
        env: execution.env
      }),
      ...(execution.toolInjection ?? {}),
      callback: {
        onThinking: (thinking: string) => sendEvent("thinking", { thinking }),
        onToolCall: (name: string, args: Record<string, unknown>) => sendEvent("tool_call", { name, args }),
        onToolResult: (name: string, result: { success: boolean; content: string; error?: string }) =>
          sendEvent("tool_result", { name, result }),
        onStep: (step: number, maxSteps: number) => sendEvent("step", { step, maxSteps }),
        onMessage: (role: string, content: string) => sendEvent("message", { role, content }),
        onError: (error: Error) => sendEvent("error", { message: error.message }),
        onComplete: (result: string, finishReason?: string, meta?) =>
          sendEvent("complete", {
            result,
            finishReason,
            usage: meta?.usage,
            recoveredFromMaxTokens: meta?.recoveredFromMaxTokens ?? false
          })
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendEvent("error", { message });
  } finally {
    response.end();
  }
}
