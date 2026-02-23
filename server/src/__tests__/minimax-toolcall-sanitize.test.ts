import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../minimax/types.js";
import {
  extractMissingToolCallId,
  isMiniMaxContextWindowExceededError,
  isMiniMaxToolResultIdNotFoundError,
  sanitizeMessagesForToolProtocol,
  trimMessagesForContextWindow
} from "../minimax/llm/LLMClient.js";
import {
  buildContextWindowRecoveryPrompt,
  buildToolCallFailRecoveryPrompt,
  isMiniMaxToolCallProtocolError
} from "../services/minimax-runner.js";

test("sanitizeMessagesForToolProtocol converts orphan tool_result into TOOLCALL_FAILED user note", () => {
  const messages: Message[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "do work" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "tool-1",
          type: "function",
          function: { name: "shell_execute", arguments: { command: "echo ok" } }
        }
      ]
    },
    { role: "tool", content: "ok", toolCallId: "tool-1", name: "shell_execute" },
    { role: "tool", content: "stale", toolCallId: "tool-missing", name: "shell_execute" }
  ];

  const result = sanitizeMessagesForToolProtocol(messages);
  assert.equal(result.correctedCount, 1);
  const last = result.messages[result.messages.length - 1];
  assert.equal(last.role, "user");
  assert.equal(typeof last.content, "string");
  assert.equal((last.content as string).includes("[TOOLCALL_FAILED]"), true);
});

test("MiniMax 2013 detection and recovery prompt formatting", () => {
  const errorMessage =
    "MiniMax run failed: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"invalid params, tool call result does not follow tool call (2013)\"}}";
  assert.equal(isMiniMaxToolCallProtocolError(errorMessage), true);
  assert.equal(isMiniMaxToolCallProtocolError("network timeout"), false);

  const prompt = buildToolCallFailRecoveryPrompt("task-xyz");
  assert.equal(prompt.includes("[TOOLCALL_FAIL]"), true);
  assert.equal(prompt.includes("task=task-xyz"), true);

  const contextPrompt = buildContextWindowRecoveryPrompt("task-xyz");
  assert.equal(contextPrompt.includes("[CONTEXT_WINDOW_RECOVERY]"), true);
  assert.equal(contextPrompt.includes("task=task-xyz"), true);
});

test("tool result id-not-found detection and extraction", () => {
  const msg =
    "400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"invalid params, tool result's tool id(call_function_c26x1fiiik9u_1) not found (2013)\"}}";
  assert.equal(isMiniMaxToolResultIdNotFoundError(msg), true);
  assert.equal(extractMissingToolCallId(msg), "call_function_c26x1fiiik9u_1");
});

test("context window error detection works for 2013 context overflow", () => {
  const msg = "400 {\"type\":\"error\",\"error\":{\"message\":\"invalid params, context window exceeds limit (2013)\"}}";
  assert.equal(isMiniMaxContextWindowExceededError(msg), true);
  assert.equal(isMiniMaxContextWindowExceededError("tool call result does not follow tool call (2013)"), false);
});

test("trimMessagesForContextWindow trims old context and keeps latest messages", () => {
  const messages: Message[] = [{ role: "system", content: "system" }];
  for (let i = 0; i < 80; i += 1) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message-${i}: ${"x".repeat(3000)}`
    });
  }
  const trimmed = trimMessagesForContextWindow(messages, {
    maxTotalChars: 24000,
    keepLatestCount: 10,
    maxNonToolChars: 2000
  });
  assert.equal(trimmed.messages.length > 0, true);
  assert.equal(trimmed.removedCount > 0, true);
  assert.equal(trimmed.trimmedChars <= 26000, true);
  const last = trimmed.messages[trimmed.messages.length - 1];
  assert.equal(typeof last.content, "string");
  assert.equal((last.content as string).includes("message-79"), true);
});
