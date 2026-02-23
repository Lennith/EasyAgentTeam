import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createProject, ensureProjectRuntime } from "../data/project-store.js";
import type { Tool } from "../minimax/tools/Tool.js";
import { createTeamTools } from "../minimax/tools/team/index.js";
import type { TeamToolBridge, TeamToolExecutionContext } from "../minimax/tools/team/types.js";

function parseToolContent(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

class RecordingBridge implements TeamToolBridge {
  public taskActionCalls: Array<Record<string, unknown>> = [];
  public sendMessageCalls: Array<Record<string, unknown>> = [];
  public getRouteTargetsCalls: string[] = [];
  public lockAcquireCalls: Array<Record<string, unknown>> = [];
  public lockRenewCalls: Array<Record<string, unknown>> = [];
  public lockReleaseCalls: Array<Record<string, unknown>> = [];
  public lockListCalls = 0;

  async taskAction(requestBody: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.taskActionCalls.push(requestBody);
    return { ok: true };
  }

  async sendMessage(requestBody: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.sendMessageCalls.push(requestBody);
    return { ok: true };
  }

  async getRouteTargets(fromAgent: string): Promise<Record<string, unknown>> {
    this.getRouteTargetsCalls.push(fromAgent);
    return { fromAgent, allowedTargets: ["a", "b"] };
  }

  async lockAcquire(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.lockAcquireCalls.push(input);
    return { result: "acquired" };
  }

  async lockRenew(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.lockRenewCalls.push(input);
    return { result: "renewed" };
  }

  async lockRelease(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.lockReleaseCalls.push(input);
    return { result: "released" };
  }

  async lockList(): Promise<Record<string, unknown>> {
    this.lockListCalls += 1;
    return { items: [], total: 0 };
  }
}

async function createToolContext(projectId: string): Promise<TeamToolExecutionContext> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-team-tools-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  const created = await createProject(dataRoot, {
    projectId,
    name: projectId,
    workspacePath
  });
  const paths = await ensureProjectRuntime(dataRoot, projectId);
  return {
    dataRoot,
    project: created.project,
    paths,
    agentRole: "dev_impl",
    sessionId: "sess-dev-1",
    activeTaskId: "task-active-1",
    activeTaskTitle: "active task",
    activeParentTaskId: "task-parent-1",
    activeRootTaskId: "task-root-1",
    activeRequestId: "req-active-1",
    parentRequestId: "req-parent-1"
  };
}

function getToolByName(tools: Tool[], name: string): Tool {
  const found = tools.find((item) => item.name === name);
  assert.ok(found, `tool '${name}' not found`);
  return found;
}

test("TaskCreateAssignTool sends TASK_CREATE payload with defaults from context", async () => {
  const context = await createToolContext("teamtools-create-1");
  const bridge = new RecordingBridge();
  const tool = getToolByName(createTeamTools({ context, bridge }), "task_create_assign");
  const result = await tool.execute({
    title: "Implement parser",
    to_role: "dev_qa",
    dependencies: "dep-1,dep-2",
    write_set: ["src/a.ts"],
    acceptance: ["tests pass"],
    artifacts: ["docs/x.md"]
  });
  assert.equal(result.success, true);
  assert.equal(bridge.taskActionCalls.length, 1);
  const payload = bridge.taskActionCalls[0];
  assert.equal(payload.action_type, "TASK_CREATE");
  assert.equal(payload.from_agent, context.agentRole);
  assert.equal(payload.parent_task_id, context.activeTaskId);
  assert.equal(payload.root_task_id, context.activeRootTaskId);
  assert.deepEqual(payload.dependencies, ["dep-1", "dep-2"]);
});

test("TaskReport tools send IN_PROGRESS / DONE / BLOCK report modes", async () => {
  const context = await createToolContext("teamtools-report-1");
  const bridge = new RecordingBridge();
  const tools = createTeamTools({ context, bridge });

  const inProgressTool = getToolByName(tools, "task_report_in_progress");
  const inProgress = await inProgressTool.execute({ content: "50% done" });
  assert.equal(inProgress.success, true);

  const doneTool = getToolByName(tools, "task_report_done");
  const done = await doneTool.execute({ task_report: "all done with evidence" });
  assert.equal(done.success, true);

  const blockTool = getToolByName(tools, "task_report_block");
  const block = await blockTool.execute({ block_reason: "missing API key" });
  assert.equal(block.success, true);

  assert.equal(bridge.taskActionCalls.length, 3);
  assert.equal(bridge.taskActionCalls[0].report_mode, "IN_PROGRESS");
  assert.equal(bridge.taskActionCalls[1].report_mode, "DONE");
  assert.equal(bridge.taskActionCalls[2].report_mode, "BLOCK");
});

test("Discuss tools send TASK_DISCUSS_* message types", async () => {
  const context = await createToolContext("teamtools-discuss-1");
  const bridge = new RecordingBridge();
  const tools = createTeamTools({ context, bridge });

  const requestTool = getToolByName(tools, "discuss_request");
  const request = await requestTool.execute({
    to_role: "arch_b",
    message: "please clarify data model",
    thread_id: "thread-1",
    round: 2
  });
  assert.equal(request.success, true);

  const replyTool = getToolByName(tools, "discuss_reply");
  const reply = await replyTool.execute({
    to_role: "arch_b",
    message: "reply here",
    thread_id: "thread-1",
    round: 3
  });
  assert.equal(reply.success, true);

  const closeTool = getToolByName(tools, "discuss_close");
  const close = await closeTool.execute({
    to_role: "arch_b",
    message: "closing thread",
    thread_id: "thread-1",
    round: 4
  });
  assert.equal(close.success, true);

  assert.equal(bridge.sendMessageCalls.length, 3);
  assert.equal(bridge.sendMessageCalls[0].message_type, "TASK_DISCUSS_REQUEST");
  assert.equal(bridge.sendMessageCalls[1].message_type, "TASK_DISCUSS_REPLY");
  assert.equal(bridge.sendMessageCalls[2].message_type, "TASK_DISCUSS_CLOSED");
});

test("RouteTargetsTool resolves default and explicit from_agent", async () => {
  const context = await createToolContext("teamtools-route-1");
  const bridge = new RecordingBridge();
  const tool = getToolByName(createTeamTools({ context, bridge }), "route_targets_get");

  const defaultCall = await tool.execute({});
  assert.equal(defaultCall.success, true);
  const defaultPayload = parseToolContent(defaultCall.content);
  assert.equal(defaultPayload.from_agent, context.agentRole);

  const explicitCall = await tool.execute({ from_agent: "qa_guard" });
  assert.equal(explicitCall.success, true);
  const explicitPayload = parseToolContent(explicitCall.content);
  assert.equal(explicitPayload.from_agent, "qa_guard");
  assert.deepEqual(bridge.getRouteTargetsCalls, [context.agentRole, "qa_guard"]);
});

test("LockManageTool maps actions to acquire/renew/release/list bridge calls", async () => {
  const context = await createToolContext("teamtools-lock-1");
  const bridge = new RecordingBridge();
  const tool = getToolByName(createTeamTools({ context, bridge }), "lock_manage");

  const acquire = await tool.execute({ action: "acquire", lock_key: "src/a.ts", ttl_seconds: 120 });
  assert.equal(acquire.success, true);

  const renew = await tool.execute({ action: "renew", lock_key: "src/a.ts" });
  assert.equal(renew.success, true);

  const release = await tool.execute({ action: "release", lock_key: "src/a.ts" });
  assert.equal(release.success, true);

  const list = await tool.execute({ action: "list" });
  assert.equal(list.success, true);

  assert.equal(bridge.lockAcquireCalls.length, 1);
  assert.equal(bridge.lockRenewCalls.length, 1);
  assert.equal(bridge.lockReleaseCalls.length, 1);
  assert.equal(bridge.lockListCalls, 1);
});
