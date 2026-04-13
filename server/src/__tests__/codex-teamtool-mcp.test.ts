import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexTeamToolConfigArgs, buildCodexTeamToolServerSpec } from "../services/codex-teamtool-mcp.js";
import { normalizeTeamToolMcpResult } from "../services/codex-teamtool-mcp-server.js";

test("codex TeamTool config args use TOML literal quoting safe for Windows shell transport", () => {
  const context = {
    scopeKind: "project" as const,
    dataRoot: "C:\\data-root",
    projectId: "project-alpha",
    workspaceRoot: "D:\\Agent Workspace\\Project Alpha",
    agentRole: "dev_impl",
    sessionId: "session-001",
    activeTaskId: "task-123",
    activeRequestId: "req-123",
    parentRequestId: "parent-123"
  };
  const spec = buildCodexTeamToolServerSpec(context);
  const args = buildCodexTeamToolConfigArgs(context);

  assert.equal(args[0], "-c");
  assert.equal(args[2], "-c");
  assert.equal(args[1], `mcp_servers.teamtool.command='${spec.command.replace(/'/g, "''")}'`);
  assert.equal(
    args[3],
    `mcp_servers.teamtool.args=[${spec.args.map((value) => `'${value.replace(/'/g, "''")}'`).join(",")}]`
  );
  assert.equal(args[1].includes('"'), false);
  assert.equal(args[3].includes('"'), false);
});

test("codex TeamTool server spec resolves tsx loader with file URL", () => {
  const context = {
    scopeKind: "project" as const,
    dataRoot: "C:\\data-root",
    projectId: "project-alpha",
    workspaceRoot: "D:\\Agent Workspace\\Project Alpha",
    agentRole: "dev_impl",
    sessionId: "session-001"
  };
  const spec = buildCodexTeamToolServerSpec(context);

  assert.equal(spec.command, process.execPath);
  assert.equal(spec.args[0], "--import");
  assert.notEqual(spec.args[1], "tsx");
  assert.equal(spec.args[1].startsWith("file:///"), true);
  assert.equal(spec.args[2].endsWith("codex-teamtool-mcp-server.ts"), true);
});

test("codex TeamTool MCP result preserves structuredContent for error payloads", () => {
  const normalized = normalizeTeamToolMcpResult({
    success: false,
    content: "",
    error: JSON.stringify({
      error_code: "TASK_EXISTS",
      message: "task already exists",
      next_action: "Do not recreate the same task_id.",
      raw: { task_id: "task-1" }
    })
  });

  assert.equal(normalized.isError, true);
  assert.equal(normalized.text.includes('"TASK_EXISTS"'), true);
  assert.deepEqual(normalized.structuredContent, {
    error_code: "TASK_EXISTS",
    message: "task already exists",
    next_action: "Do not recreate the same task_id.",
    raw: { task_id: "task-1" }
  });
});
