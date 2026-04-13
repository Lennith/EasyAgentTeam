import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { ProjectPaths } from "../domain/models.js";
import {
  buildProjectCodexRuntimeHome,
  buildSessionCodexRuntimeHome,
  buildWorkflowCodexRuntimeHome,
  ensureCodexRuntimeHome
} from "../services/codex-runtime-home.js";

function createProjectPaths(tempRoot: string): ProjectPaths {
  const collabDir = path.join(tempRoot, "collab");
  return {
    projectRootDir: tempRoot,
    projectConfigFile: path.join(tempRoot, "project.json"),
    collabDir,
    eventsFile: path.join(collabDir, "events.jsonl"),
    taskboardFile: path.join(collabDir, "state", "taskboard.json"),
    sessionsFile: path.join(collabDir, "state", "sessions.json"),
    roleRemindersFile: path.join(collabDir, "state", "role-reminders.json"),
    locksDir: path.join(collabDir, "locks"),
    inboxDir: path.join(collabDir, "inbox"),
    outboxDir: path.join(collabDir, "outbox"),
    auditDir: path.join(collabDir, "audit"),
    agentOutputFile: path.join(collabDir, "audit", "agent_output.jsonl"),
    promptsDir: path.join(collabDir, "prompts")
  };
}

test("project codex runtime home stays under collab runtime data", () => {
  const paths = createProjectPaths("C:\\runtime\\project_alpha");
  const home = buildProjectCodexRuntimeHome(paths, "dev_impl");
  assert.equal(home, path.join(paths.collabDir, "codex-home", "dev_impl"));
});

test("workflow codex runtime home stays under workflow runtime data", () => {
  const home = buildWorkflowCodexRuntimeHome("C:\\runtime\\data", "wf-run-1", "lead");
  assert.equal(home, path.join("C:\\runtime\\data", "workflows", "runs", "wf-run-1", "codex-home", "lead"));
});

test("session codex runtime home resolves from teamtool context before workspace fallback", () => {
  const workflowHome = buildSessionCodexRuntimeHome({
    sessionDirFallback: "D:\\workspace\\.minimax\\sessions",
    workspaceRoot: "D:\\workspace",
    role: "lead",
    codexTeamToolContext: {
      scopeKind: "workflow",
      dataRoot: "C:\\runtime\\data",
      runId: "wf-run-2",
      workspaceRoot: "D:\\workspace",
      agentRole: "lead",
      sessionId: "session-lead"
    }
  });
  assert.equal(workflowHome, path.join("C:\\runtime\\data", "workflows", "runs", "wf-run-2", "codex-home", "lead"));

  const fallbackHome = buildSessionCodexRuntimeHome({
    sessionDirFallback: "D:\\workspace\\.minimax\\sessions",
    workspaceRoot: "D:\\workspace",
    role: "qa_guard"
  });
  assert.equal(fallbackHome, path.join("D:\\workspace", ".codex-runtime", "qa_guard"));
});

test("ensureCodexRuntimeHome writes isolated config and copies auth without global MCP servers", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-codex-home-"));
  const authRoot = path.join(tempRoot, "global-home");
  await mkdir(authRoot, { recursive: true });
  await writeFile(path.join(authRoot, "auth.json"), '{"auth_mode":"chatgpt"}', "utf8");
  process.env.AUTO_DEV_CODEX_AUTH_SOURCE_DIR = authRoot;
  const codexHome = path.join(tempRoot, "codex-home", "dev_impl");
  try {
    await ensureCodexRuntimeHome(codexHome);
    const config = await readFile(path.join(codexHome, "config.toml"), "utf8");
    const auth = await readFile(path.join(codexHome, "auth.json"), "utf8");
    assert.equal(config.includes('approval_policy = "never"'), true);
    assert.equal(config.includes('sandbox_mode = "danger-full-access"'), true);
    assert.equal(config.includes("mcp_servers.playwright"), false);
    assert.equal(auth, '{"auth_mode":"chatgpt"}');
  } finally {
    delete process.env.AUTO_DEV_CODEX_AUTH_SOURCE_DIR;
  }
});
