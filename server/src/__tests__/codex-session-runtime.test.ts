import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexSessionArgs,
  isCodexTaskCompleteSignal,
  normalizeCodexToolResultItem,
  resolveCodexToolName
} from "../services/codex-session-runtime.js";

test("codex session args include explicit model and reasoning config for new sessions", () => {
  const built = buildCodexSessionArgs({
    providerSessionId: "pending-dev-session",
    model: "gpt-5.3-codex",
    reasoningEffort: "medium"
  });

  assert.equal(built.shouldResume, false);
  assert.deepEqual(built.args.slice(0, 5), [
    "exec",
    "--json",
    "--sandbox",
    "danger-full-access",
    "--dangerously-bypass-approvals-and-sandbox"
  ]);
  assert.equal(built.args.includes("--model"), true);
  assert.equal(built.args.includes("gpt-5.3-codex"), true);
  assert.equal(built.args.includes("-c"), true);
  assert.equal(built.args.includes('model_reasoning_effort="medium"'), true);
});

test("codex session args preserve resume syntax and normalize unsupported effort values away", () => {
  const built = buildCodexSessionArgs({
    providerSessionId: "019d7da6-72be-7d20-bf17-40f7ef874734",
    model: "gpt-5.3-codex",
    reasoningEffort: "xhigh"
  });

  assert.equal(built.shouldResume, true);
  assert.deepEqual(built.args.slice(0, 5), [
    "exec",
    "resume",
    "019d7da6-72be-7d20-bf17-40f7ef874734",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox"
  ]);
  assert.equal(built.args.includes("--sandbox"), false);
  assert.equal(built.args.includes('model_reasoning_effort="xhigh"'), false);
});

test("codex session runtime normalizes MCP tool_result structuredContent payload", () => {
  const normalized = normalizeCodexToolResultItem({
    type: "mcp_tool_result",
    name: "mcp__teamtool__task_create_assign",
    is_error: true,
    structuredContent: {
      error_code: "TASK_EXISTS",
      message: "task already exists",
      next_action: "Do not recreate the same task_id.",
      raw: { task_id: "task-1" }
    },
    content: [
      {
        type: "text",
        text: '{"error_code":"TASK_EXISTS","message":"task already exists","next_action":"Do not recreate the same task_id.","raw":{"task_id":"task-1"}}'
      }
    ]
  });

  assert.equal(normalized.success, false);
  assert.equal(normalized.content.includes('"TASK_EXISTS"'), true);
  assert.match(String(normalized.error ?? ""), /TASK_EXISTS/);
});

test("codex session runtime resolves MCP tool names from item.tool", () => {
  const resolved = resolveCodexToolName({
    type: "mcp_tool_call",
    server: "teamtool",
    tool: "task_report_done",
    id: "item_23"
  });

  assert.equal(resolved, "task_report_done");
});

test("codex session runtime detects task_complete signal from top-level event", () => {
  const isTaskComplete = isCodexTaskCompleteSignal({
    type: "task_complete"
  });

  assert.equal(isTaskComplete, true);
});

test("codex session runtime detects task_complete signal from nested payload/item", () => {
  const nestedPayloadSignal = isCodexTaskCompleteSignal({
    type: "event_msg",
    payload: {
      type: "task_complete",
      last_agent_message: "done"
    }
  });
  const nestedItemSignal = isCodexTaskCompleteSignal({
    item: {
      type: "task_complete"
    }
  });

  assert.equal(nestedPayloadSignal, true);
  assert.equal(nestedItemSignal, true);
});
