import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { CodexModelRunner } from "../services/codex-runner.js";
import type { ProjectPaths, ProjectRecord } from "../domain/models.js";
import { buildProjectCodexRuntimeHome } from "../services/codex-runtime-home.js";
import { addSession, getSession } from "../data/repository/project/session-repository.js";

function buildProjectAndPaths(tempRoot: string): { project: ProjectRecord; paths: ProjectPaths } {
  const project: ProjectRecord = {
    schemaVersion: "1.0",
    projectId: "runner-test",
    name: "Runner Test",
    workspacePath: tempRoot,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const collabDir = path.join(tempRoot, "collab");
  return {
    project,
    paths: {
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
    }
  };
}

test("codex resume command uses exec resume syntax", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-codex-runner-"));
  const { project, paths } = buildProjectAndPaths(tempRoot);
  const runner = new CodexModelRunner(project, paths, {
    sessionId: "sess-a",
    prompt: "ping",
    cliTool: "codex",
    resumeSessionId: "resume-id-123",
    modelParams: {
      model: "gpt-5.3-codex"
    }
  });

  const command = runner.buildCommand();
  assert.equal(command.mode, "resume");
  assert.deepEqual(command.args.slice(0, 3), ["exec", "resume", "resume-id-123"]);
  assert.equal(command.args.includes("--json"), true);
  assert.equal(command.args.includes("--sandbox"), false);
  assert.notEqual(command.args[command.args.length - 1], "-");
});

test("codex exec command enables json output for project runner parity", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-codex-runner-json-"));
  const { project, paths } = buildProjectAndPaths(tempRoot);
  const runner = new CodexModelRunner(project, paths, {
    sessionId: "sess-json",
    prompt: "ping",
    cliTool: "codex"
  });

  const command = runner.buildCommand();
  assert.equal(command.mode, "exec");
  assert.deepEqual(command.args.slice(0, 4), ["exec", "--json", "--sandbox", "danger-full-access"]);
});

test("codex runner extracts thread id from json event lines", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-codex-runner-thread-id-"));
  const { project, paths } = buildProjectAndPaths(tempRoot);
  const runner = new CodexModelRunner(project, paths, {
    sessionId: "sess-thread",
    prompt: "ping",
    cliTool: "codex"
  });

  const sessionId = runner.extractSessionId(
    JSON.stringify({
      type: "thread.started",
      thread_id: "123e4567-e89b-12d3-a456-426614174000"
    })
  );
  assert.equal(sessionId, "123e4567-e89b-12d3-a456-426614174000");
});

test("runner windows env keeps system command paths available", async () => {
  if (process.platform !== "win32") {
    return;
  }
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-codex-runner-env-"));
  const { project, paths } = buildProjectAndPaths(tempRoot);
  const runner = new CodexModelRunner(project, paths, {
    sessionId: "sess-env",
    prompt: "ping",
    cliTool: "codex",
    taskId: "task-123",
    activeTaskTitle: "Implement parser",
    activeParentTaskId: "user-root-1",
    activeRootTaskId: "user-root-1",
    activeRequestId: "req-123"
  });

  const codexHome = buildProjectCodexRuntimeHome(paths, "sess-env");
  const modelEnv = (runner as any).withModelEnv(tempRoot, codexHome) as NodeJS.ProcessEnv;
  const pathValue = modelEnv.PATH ?? modelEnv.Path ?? "";
  const normalized = pathValue.toLowerCase();
  assert.equal(normalized.includes("\\system32"), true);
  assert.equal(normalized.includes("\\windowspowershell\\v1.0"), true);
  assert.equal((modelEnv.ComSpec ?? "").toLowerCase().endsWith("\\system32\\cmd.exe"), true);
  assert.ok((modelEnv.SystemRoot ?? "").length > 0);
  assert.equal(modelEnv.AUTO_DEV_ACTIVE_TASK_ID, "task-123");
  assert.equal(modelEnv.AUTO_DEV_ACTIVE_TASK_TITLE, "Implement parser");
  assert.equal(modelEnv.AUTO_DEV_ACTIVE_PARENT_TASK_ID, "user-root-1");
  assert.equal(modelEnv.AUTO_DEV_ACTIVE_ROOT_TASK_ID, "user-root-1");
  assert.equal(modelEnv.AUTO_DEV_ACTIVE_REQUEST_ID, "req-123");
  assert.equal(modelEnv.CODEX_HOME, codexHome);
});

test("runner injects active task context env vars", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-codex-runner-active-task-env-"));
  const { project, paths } = buildProjectAndPaths(tempRoot);
  const runner = new CodexModelRunner(project, paths, {
    sessionId: "sess-env-any",
    prompt: "ping",
    cliTool: "codex",
    agentRole: "dev_impl",
    parentRequestId: "parent-req-1",
    taskId: "task-abc",
    activeTaskTitle: "Build API",
    activeParentTaskId: "parent-1",
    activeRootTaskId: "root-1",
    activeRequestId: "req-1"
  });

  const codexHome = buildProjectCodexRuntimeHome(paths, "dev_impl");
  const modelEnv = (runner as any).withModelEnv(tempRoot, codexHome) as NodeJS.ProcessEnv;
  assert.equal(modelEnv.AUTO_DEV_PROJECT_ID, "runner-test");
  assert.equal(modelEnv.AUTO_DEV_AGENT_ROLE, "dev_impl");
  assert.equal(modelEnv.AUTO_DEV_SESSION_ID, "sess-env-any");
  assert.equal(modelEnv.AUTO_DEV_PARENT_REQUEST_ID, "parent-req-1");
  assert.equal(modelEnv.AUTO_DEV_ACTIVE_TASK_ID, "task-abc");
  assert.equal(modelEnv.AUTO_DEV_ACTIVE_TASK_TITLE, "Build API");
  assert.equal(modelEnv.AUTO_DEV_ACTIVE_PARENT_TASK_ID, "parent-1");
  assert.equal(modelEnv.AUTO_DEV_ACTIVE_ROOT_TASK_ID, "root-1");
  assert.equal(modelEnv.AUTO_DEV_ACTIVE_REQUEST_ID, "req-1");
  assert.equal(modelEnv.CODEX_HOME, codexHome);
});

test("codex runner log activity refreshes session heartbeat", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-codex-runner-heartbeat-"));
  const { project, paths } = buildProjectAndPaths(tempRoot);
  await addSession(paths, project.projectId, {
    sessionId: "sess-heartbeat",
    role: "lead",
    status: "running",
    provider: "codex"
  });
  const before = await getSession(paths, project.projectId, "sess-heartbeat");
  assert.ok(before);

  const runner = new CodexModelRunner(project, paths, {
    sessionId: "sess-heartbeat",
    prompt: "ping",
    cliTool: "codex"
  });

  await (runner as any).appendLog("system", "heartbeat-probe");

  const after = await getSession(paths, project.projectId, "sess-heartbeat");
  assert.ok(after);
  assert.notEqual(after?.lastActiveAt, before?.lastActiveAt);
});
