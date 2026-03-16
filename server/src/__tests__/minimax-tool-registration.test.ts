import assert from "node:assert/strict";
import { test } from "node:test";
import { Tool } from "../minimax/tools/Tool.js";
import { ToolRegistry } from "../minimax/tools/ToolRegistry.js";
import {
  createToolRegistrationState,
  registerToolWithDedupe,
  resolveToolCapabilityFamily
} from "../minimax/tools/tool-registration.js";
import type { ToolResult } from "../minimax/types.js";

class FakeTool extends Tool {
  constructor(
    private readonly toolName: string,
    private readonly toolDescription: string = "fake tool"
  ) {
    super();
  }

  get name(): string {
    return this.toolName;
  }

  get description(): string {
    return this.toolDescription;
  }

  get parameters(): Record<string, unknown> {
    return { type: "object", properties: {}, required: [] };
  }

  async execute(): Promise<ToolResult> {
    return { success: true, content: "ok" };
  }
}

test("resolveToolCapabilityFamily maps known names to stable capability families", () => {
  assert.equal(resolveToolCapabilityFamily("task_create_assign"), "task_manage");
  assert.equal(resolveToolCapabilityFamily("task_report_done"), "task_report_done");
  assert.equal(resolveToolCapabilityFamily("discuss_request"), "discuss_request");
  assert.equal(resolveToolCapabilityFamily("read_file"), "file_read");
  assert.equal(resolveToolCapabilityFamily("grep"), "file_grep");
  assert.equal(resolveToolCapabilityFamily("session_note"), "note");
  assert.equal(resolveToolCapabilityFamily("summary_messages"), "summary_messages");
  assert.equal(resolveToolCapabilityFamily("custom_tool_x"), "tool:custom_tool_x");
});

test("registerToolWithDedupe prefers higher-priority source for same capability family", () => {
  const registry = new ToolRegistry();
  const state = createToolRegistrationState();
  const coreReportDone = new FakeTool("task_report_done");
  const teamReportDone = new FakeTool("task_report_done");

  const first = registerToolWithDedupe(registry, state, coreReportDone, "core");
  assert.equal(first.skipped, false);
  assert.equal(registry.has("task_report_done"), true);

  const second = registerToolWithDedupe(registry, state, teamReportDone, "team");
  assert.equal(second.skipped, true);
  if (second.skipped) {
    assert.equal(second.reason, "duplicate_name");
  }
  assert.equal(registry.has("task_report_done"), true);
});

test("registerToolWithDedupe skips lower-priority capability conflicts", () => {
  const registry = new ToolRegistry();
  const state = createToolRegistrationState();
  const teamTool = new FakeTool("task_create_assign");
  const otherTool = new FakeTool("task_create");

  const teamFirst = registerToolWithDedupe(registry, state, teamTool, "team");
  assert.equal(teamFirst.skipped, false);

  const otherConflict = registerToolWithDedupe(registry, state, otherTool, "other");
  assert.equal(otherConflict.skipped, true);
  if (otherConflict.skipped) {
    assert.equal(otherConflict.reason, "capability_conflict");
    assert.equal(otherConflict.keptToolName, "task_create_assign");
  }
  assert.equal(registry.has("task_create_assign"), true);
  assert.equal(registry.has("task_create"), false);
});
