import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createProject } from "../data/repository/project/runtime-repository.js";
import { BASE_PROMPT_TEXT } from "../services/agent-prompt-service.js";
import { buildAgentWorkspaceAgentsMd, ensureAgentWorkspaces } from "../services/agent-workspace-service.js";
import { composeSystemPrompt } from "../services/prompt-composer.js";

const TEAM_TOOL_NAMES = [
  "task_create_assign",
  "task_report_in_progress",
  "task_report_done",
  "task_report_block",
  "discuss_request",
  "discuss_reply",
  "discuss_close",
  "route_targets_get",
  "lock_manage"
] as const;

function resolveTeamToolsListPath(): string {
  const candidates = [
    path.resolve(process.cwd(), "TeamsTools", "TeamToolsList.md"),
    path.resolve(process.cwd(), "..", "TeamsTools", "TeamToolsList.md")
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const stat = statSync(candidate);
    if (stat.isFile()) {
      return candidate;
    }
  }
  throw new Error("TeamToolsList.md not found from current test working directory");
}

function resolveOrchestratorServicePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "src", "services", "orchestrator", "project", "project-orchestrator.ts"),
    path.resolve(process.cwd(), "server", "src", "services", "orchestrator", "project", "project-orchestrator.ts")
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const stat = statSync(candidate);
    if (stat.isFile()) {
      return candidate;
    }
  }
  throw new Error("project/project-orchestrator.ts not found from current test working directory");
}

test("agent-visible prompts/doc index use registered TeamTools names consistently", async () => {
  for (const toolName of TEAM_TOOL_NAMES) {
    assert.equal(BASE_PROMPT_TEXT.includes(toolName), true, `BASE_PROMPT_TEXT should include ${toolName}`);
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-toolprompt-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  const { project } = await createProject(dataRoot, {
    projectId: "toolprompt",
    name: "Tool Prompt",
    workspacePath,
    agentIds: ["dev_impl"]
  });

  await ensureAgentWorkspaces(
    project,
    new Map<string, string>([["dev_impl", "Implement assigned tasks and report progress."]]),
    ["dev_impl"]
  );

  const generatedAgentsMd = await fs.readFile(path.join(workspacePath, "Agents", "dev_impl", "AGENTS.md"), "utf8");
  assert.equal(generatedAgentsMd.includes("task_report_in_progress, task_report_done, task_report_block"), true);
  assert.equal(generatedAgentsMd.includes("discuss_request/discuss_reply/discuss_close"), true);
  assert.equal(generatedAgentsMd.includes("discuss_*.ps1"), false);
  assert.equal(generatedAgentsMd.includes("report_task_*"), false);

  const teamToolsList = await fs.readFile(resolveTeamToolsListPath(), "utf8");
  for (const toolName of TEAM_TOOL_NAMES) {
    assert.equal(teamToolsList.includes(`\`${toolName}\``), true, `TeamToolsList should include ${toolName}`);
  }

  const orchestratorSource = await fs.readFile(resolveOrchestratorServicePath(), "utf8");
  assert.equal(orchestratorSource.includes("discuss_*.ps1"), false);
  assert.equal(orchestratorSource.includes("report_task_* TeamTools"), false);
  assert.equal(orchestratorSource.includes("`discuss_request`, `discuss_reply`, `discuss_close`"), true);
  assert.equal(orchestratorSource.includes("`task_report_in_progress`, `task_report_done`, `task_report_block`"), true);
});

test("runtime prompt and workspace guide switch by host platform", () => {
  const windowsPrompt = composeSystemPrompt({
    providerId: "minimax",
    hostPlatform: "win32"
  }).systemPrompt;
  const linuxPrompt = composeSystemPrompt({
    providerId: "minimax",
    hostPlatform: "linux"
  }).systemPrompt;
  const macPrompt = composeSystemPrompt({
    providerId: "minimax",
    hostPlatform: "darwin"
  }).systemPrompt;

  assert.equal(windowsPrompt.includes("Use PowerShell/CMD syntax only."), true);
  assert.equal(windowsPrompt.includes("Do not use bash/sh/zsh syntax."), true);
  assert.equal(linuxPrompt.includes("Use bash/sh syntax only."), true);
  assert.equal(linuxPrompt.includes("Do not use PowerShell/CMD syntax."), true);
  assert.equal(macPrompt.includes("macOS support is design-compatible"), true);

  const windowsGuide = buildAgentWorkspaceAgentsMd("win32");
  const linuxGuide = buildAgentWorkspaceAgentsMd("linux");
  const macGuide = buildAgentWorkspaceAgentsMd("darwin");

  assert.equal(windowsGuide.includes("YOUR RUNTIME IS WINDOWS"), true);
  assert.equal(windowsGuide.includes("Use PowerShell/CMD"), true);
  assert.equal(linuxGuide.includes("YOUR RUNTIME IS LINUX"), true);
  assert.equal(linuxGuide.includes("Use POSIX shell commands"), true);
  assert.equal(macGuide.includes("YOUR RUNTIME IS MACOS"), true);
  assert.equal(macGuide.includes("design-compatible but not fully validated"), true);
});
