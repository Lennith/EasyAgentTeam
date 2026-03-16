import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createProject, ensureProjectRuntime } from "../data/project-store.js";
import type { TeamToolBridge, TeamToolExecutionContext } from "../minimax/tools/team/types.js";
import { createMiniMaxAgent } from "../minimax/index.js";

function createNoopBridge(): TeamToolBridge {
  return {
    async taskAction() {
      return { ok: true };
    },
    async sendMessage() {
      return { ok: true };
    },
    async getRouteTargets() {
      return { allowedTargets: [] };
    },
    async lockAcquire() {
      return { result: "acquired" };
    },
    async lockRenew() {
      return { result: "renewed" };
    },
    async lockRelease() {
      return { result: "released" };
    },
    async lockList() {
      return { items: [], total: 0 };
    }
  };
}

test("MiniMax registry excludes list_directory and includes team tools when context is provided", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-minimax-registry-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  const { project } = await createProject(dataRoot, {
    projectId: "minimaxregistry",
    name: "MiniMax Registry",
    workspacePath
  });
  const paths = await ensureProjectRuntime(dataRoot, project.projectId);

  const context: TeamToolExecutionContext = {
    dataRoot,
    project,
    paths,
    agentRole: "dev_impl",
    sessionId: "sess-dev",
    activeTaskId: "task-1",
    activeTaskTitle: "Task 1",
    activeParentTaskId: "parent-1",
    activeRootTaskId: "root-1",
    activeRequestId: "req-1",
    parentRequestId: "req-parent-1"
  };

  const agent = createMiniMaxAgent({
    config: {
      apiKey: "test-api-key",
      apiBase: "https://api.minimax.io",
      model: "MiniMax-M2.5",
      maxSteps: 20,
      tokenLimit: 32000,
      workspaceDir: workspacePath,
      enableFileTools: true,
      enableShell: false,
      enableNote: false,
      shellType: "powershell",
      shellTimeout: 30000,
      mcpEnabled: false,
      mcpServers: [],
      mcpConnectTimeout: 30000,
      mcpExecuteTimeout: 60000,
      teamToolContext: context,
      teamToolBridge: createNoopBridge()
    }
  });

  await agent.initialize();
  const registry = agent.getToolRegistry();
  assert.ok(registry);
  const names = new Set((registry?.getAll() ?? []).map((tool) => tool.name));

  assert.equal(names.has("read_file"), true);
  assert.equal(names.has("write_file"), true);
  assert.equal(names.has("edit_file"), true);
  assert.equal(names.has("glob"), true);
  assert.equal(names.has("grep"), true);
  assert.equal(names.has("web_fetch"), true);
  assert.equal(names.has("web_search"), true);
  assert.equal(names.has("summary_messages"), true);
  assert.equal(names.has("list_directory"), false);

  assert.equal(names.has("task_create_assign"), true);
  assert.equal(names.has("task_report_in_progress"), true);
  assert.equal(names.has("task_report_done"), true);
  assert.equal(names.has("task_report_block"), true);
  assert.equal(names.has("discuss_request"), true);
  assert.equal(names.has("discuss_reply"), true);
  assert.equal(names.has("discuss_close"), true);
  assert.equal(names.has("route_targets_get"), true);
  assert.equal(names.has("lock_manage"), true);
});
