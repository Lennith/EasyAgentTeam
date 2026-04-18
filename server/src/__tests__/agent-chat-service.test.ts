import assert from "node:assert/strict";
import test from "node:test";
import { streamAgentChat, type AgentChatContextAdapter } from "../services/agent-chat-service.js";
import { ProviderLaunchError } from "../services/provider-launch-error.js";

test("agent chat SSE emits structured provider error payload", async () => {
  const chunks: string[] = [];
  const response = {
    setHeader: () => {},
    write: (chunk: string) => {
      chunks.push(chunk);
    },
    end: () => {}
  } as any;

  const adapter: AgentChatContextAdapter = {
    resolve: async () => ({
      providerId: "minimax",
      settings: {
        schemaVersion: "1.0",
        updatedAt: new Date().toISOString(),
        codexCliCommand: "codex"
      },
      sessionId: "session-chat",
      providerSessionId: "provider-session-chat",
      workspaceDir: "C:\\workspace\\agent",
      workspaceRoot: "C:\\workspace",
      role: "lead",
      prompt: "hello",
      rolePrompt: "role prompt",
      skillSegments: [],
      skillIds: [],
      contextKind: "workflow_agent_chat",
      runtimeConstraints: [],
      sessionDirFallback: "C:\\sessions",
      apiBaseFallback: "https://api.minimax.io",
      modelFallback: "MiniMax-M2.5-High-speed",
      env: {}
    })
  };

  await streamAgentChat(
    response,
    {
      runSessionWithTools: async () => {
        throw new ProviderLaunchError({
          code: "PROVIDER_UPSTREAM_TRANSIENT_ERROR",
          category: "runtime",
          retryable: true,
          message: "MiniMax upstream returned transient status 529.",
          nextAction: "Wait for cooldown and retry the same task/message dispatch.",
          details: {
            status: 529
          }
        });
      }
    } as any,
    adapter,
    {
      role: "lead",
      prompt: "hello"
    }
  );

  const payloadText = chunks.join("");
  assert.equal(payloadText.includes("event: error"), true);
  assert.equal(payloadText.includes('"code":"PROVIDER_UPSTREAM_TRANSIENT_ERROR"'), true);
  assert.equal(payloadText.includes('"retryable":true'), true);
  assert.equal(payloadText.includes('"status":529'), true);
});
