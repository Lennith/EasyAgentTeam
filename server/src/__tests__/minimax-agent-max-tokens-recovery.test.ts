import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { Agent } from "../minimax/agent/Agent.js";
import type { LLMClient } from "../minimax/llm/LLMClient.js";
import { ToolRegistry } from "../minimax/tools/ToolRegistry.js";
import type { LLMResponse, MaxTokensRecoveryEvent, TokenUsage } from "../minimax/types.js";

class FakeLlmClient {
  private index = 0;

  constructor(private readonly responses: LLMResponse[]) {}

  async generate(): Promise<LLMResponse> {
    const cursor = Math.min(this.index, this.responses.length - 1);
    const response = this.responses[cursor];
    this.index += 1;
    return response;
  }
}

function usage(promptTokens: number, completionTokens: number): TokenUsage {
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens
  };
}

test("agent recovers from one max_tokens and completes with usage metadata", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-minimax-agent-max-token-"));
  const llm = new FakeLlmClient([
    {
      content: "partial draft",
      finishReason: "max_tokens",
      usage: usage(1000, 16000)
    },
    {
      content: "final answer",
      finishReason: "end_turn",
      usage: usage(1200, 800)
    }
  ]);
  const tools = new ToolRegistry();
  const recoveryEvents: MaxTokensRecoveryEvent[] = [];
  let completedFinishReason: string | undefined;
  let completedUsageTotal: number | undefined;
  let completedRecovered: boolean | undefined;
  const agent = new Agent({
    llmClient: llm as unknown as LLMClient,
    toolRegistry: tools,
    systemPrompt: "system",
    workspaceDir: workspaceRoot,
    callback: {
      onMaxTokensRecovery: (event) => {
        recoveryEvents.push(event);
      },
      onComplete: (_result, finishReason, meta) => {
        completedFinishReason = finishReason;
        completedUsageTotal = meta?.usage?.totalTokens;
        completedRecovered = meta?.recoveredFromMaxTokens;
      }
    }
  });

  const result = await agent.runWithResult("start");
  assert.equal(result.finishReason, "end_turn");
  assert.equal(result.recoveredFromMaxTokens, true);
  assert.equal(result.maxTokensRecoveryAttempt, 1);
  assert.equal((result.maxTokensEvents ?? []).length, 1);
  assert.equal(recoveryEvents.length, 1);
  assert.equal(recoveryEvents[0].recovered, true);
  assert.equal(recoveryEvents[0].finishReason, "max_tokens");
  assert.equal(completedFinishReason, "end_turn");
  assert.equal(completedUsageTotal, 2000);
  assert.equal(completedRecovered, true);
});

test("agent stops after max_tokens recovery budget is exhausted", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-minimax-agent-max-token-hard-stop-"));
  const llm = new FakeLlmClient([
    {
      content: "part-1",
      finishReason: "max_tokens",
      usage: usage(900, 16384)
    },
    {
      content: "part-2",
      finishReason: "max_tokens",
      usage: usage(920, 16384)
    },
    {
      content: "part-3",
      finishReason: "max_tokens",
      usage: usage(950, 16384)
    }
  ]);
  const tools = new ToolRegistry();
  const recoveryEvents: MaxTokensRecoveryEvent[] = [];
  let finalFinishReason: string | undefined;
  const agent = new Agent({
    llmClient: llm as unknown as LLMClient,
    toolRegistry: tools,
    systemPrompt: "system",
    workspaceDir: workspaceRoot,
    callback: {
      onMaxTokensRecovery: (event) => {
        recoveryEvents.push(event);
      },
      onComplete: (_result, finishReason) => {
        finalFinishReason = finishReason;
      }
    }
  });

  const result = await agent.runWithResult("start");
  assert.equal(result.finishReason, "max_tokens");
  assert.equal(result.maxTokensRecoveryAttempt, 3);
  assert.equal((result.maxTokensEvents ?? []).length, 3);
  assert.equal(recoveryEvents.length, 3);
  assert.equal(recoveryEvents[2].recovered, false);
  assert.equal(finalFinishReason, "max_tokens");
});
