import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import type { LLMClient } from "../minimax/llm/LLMClient.js";
import { Agent } from "../minimax/agent/Agent.js";
import { ToolRegistry } from "../minimax/tools/ToolRegistry.js";
import { createSummaryMessagesTool } from "../minimax/tools/SummaryMessagesTool.js";
import type { LLMResponse, SummaryApplyAppliedEvent, SummaryApplyAcceptedEvent } from "../minimax/types.js";

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

test("agent applies pending summary after tool batch without breaking run", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-summary-agent-"));
  const llm = new FakeLlmClient([
    {
      content: "",
      finishReason: "tool_use",
      toolCalls: [
        {
          id: "tool-1",
          type: "function",
          function: {
            name: "summary_messages",
            arguments: {
              action: "apply",
              checkpoint_id: "ckpt-1",
              summary: "Only keep requirement and next action.",
              keep_recent_messages: 0
            }
          }
        }
      ]
    },
    {
      content: "final answer",
      finishReason: "end_turn"
    }
  ]);

  const tools = new ToolRegistry();
  let agentRef: Agent | null = null;
  tools.register(
    createSummaryMessagesTool({
      bridge: {
        isDisabled: () => false,
        listCheckpoints: (limit) => agentRef?.listSummaryCheckpoints(limit) ?? [],
        enqueueApply: (request) =>
          agentRef?.enqueueSummaryApply(request) ?? { accepted: false, availableCheckpoints: 0 }
      }
    })
  );

  const acceptedEvents: SummaryApplyAcceptedEvent[] = [];
  const appliedEvents: SummaryApplyAppliedEvent[] = [];
  const agent = new Agent({
    llmClient: llm as unknown as LLMClient,
    toolRegistry: tools,
    systemPrompt: "system",
    workspaceDir: workspaceRoot,
    callback: {
      onSummaryMessagesAccepted: (event) => acceptedEvents.push(event),
      onSummaryMessagesApplied: (event) => appliedEvents.push(event)
    }
  });
  agentRef = agent;

  const result = await agent.runWithResult("do task");
  assert.equal(result.content, "final answer");
  assert.equal(result.finishReason, "end_turn");
  assert.equal(acceptedEvents.length, 1);
  assert.equal(appliedEvents.length, 1);

  const messages = agent.getMessages();
  const anchor = messages.find((item) => item.metadata?.summaryAnchor);
  assert.ok(anchor);
  assert.equal(typeof anchor?.content, "string");
  assert.equal(String(anchor?.content).includes("[SUMMARY_MESSAGES_APPLIED checkpoint_id=ckpt-1]"), true);
  const orphanTools = messages.filter((item) => item.role === "tool");
  assert.equal(orphanTools.length, 0);
});
