import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { Agent } from "../minimax/agent/Agent.js";
import type { LLMClient } from "../minimax/llm/LLMClient.js";
import type { LLMResponse, ToolResult } from "../minimax/types.js";
import { Tool } from "../minimax/tools/Tool.js";
import { ToolRegistry } from "../minimax/tools/ToolRegistry.js";

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

class StaticTool extends Tool {
  constructor(
    private readonly toolName: string,
    private readonly payload: string
  ) {
    super();
  }

  get name(): string {
    return this.toolName;
  }

  get description(): string {
    return `static tool ${this.toolName}`;
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {}
    };
  }

  async execute(_args: Record<string, unknown>): Promise<ToolResult> {
    return {
      success: true,
      content: this.payload
    };
  }
}

test("agent truncates large tool results before appending tool messages", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-agent-tool-truncate-"));
  const longPayload = "X".repeat(10000);

  const tools = new ToolRegistry();
  tools.register(new StaticTool("read_file", longPayload));
  tools.register(new StaticTool("task_report_done", longPayload));
  tools.register(new StaticTool("lock_manage", longPayload));
  tools.register(new StaticTool("route_targets_get", longPayload));
  tools.register(new StaticTool("custom_big_tool", longPayload));

  const llm = new FakeLlmClient([
    {
      content: "",
      finishReason: "tool_use",
      toolCalls: [
        { id: "t1", type: "function", function: { name: "read_file", arguments: {} } },
        { id: "t2", type: "function", function: { name: "task_report_done", arguments: {} } },
        { id: "t3", type: "function", function: { name: "lock_manage", arguments: {} } },
        { id: "t4", type: "function", function: { name: "route_targets_get", arguments: {} } },
        { id: "t5", type: "function", function: { name: "custom_big_tool", arguments: {} } }
      ]
    },
    {
      content: "done",
      finishReason: "end_turn"
    }
  ]);

  const agent = new Agent({
    llmClient: llm as unknown as LLMClient,
    toolRegistry: tools,
    systemPrompt: "system",
    workspaceDir: workspaceRoot
  });

  const result = await agent.runWithResult("start");
  assert.equal(result.finishReason, "end_turn");

  const toolMessages = agent.getMessages().filter((message) => message.role === "tool");
  const byName = new Map(toolMessages.map((message) => [message.name, String(message.content)]));

  const assertTruncatedWithin = (toolName: string, maxChars: number): void => {
    const content = byName.get(toolName) ?? "";
    assert.equal(content.startsWith(`[TOOL_RESULT_TRUNCATED tool=${toolName}`), true);
    assert.equal(content.length <= maxChars, true);
  };

  assertTruncatedWithin("read_file", 6000);
  assertTruncatedWithin("task_report_done", 3500);
  assertTruncatedWithin("lock_manage", 1500);
  assertTruncatedWithin("route_targets_get", 3000);
  assertTruncatedWithin("custom_big_tool", 4000);
});
