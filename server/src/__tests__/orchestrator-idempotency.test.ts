import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { appendEvent, listEvents } from "../data/repository/project/event-repository.js";
import { createProject, ensureProjectRuntime } from "../data/repository/project/runtime-repository.js";
import { addSession } from "../data/repository/project/session-repository.js";
import { createTask } from "../data/repository/project/taskboard-repository.js";
import { OrchestratorService } from "../services/orchestrator/index.js";
import { createProviderRegistry } from "../services/provider-runtime.js";

test("dispatch skips duplicate open task dispatch for same task/session", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-orchestrator-idempotency-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  const created = await createProject(dataRoot, {
    projectId: "idempotency",
    name: "Idempotency",
    workspacePath
  });
  const project = created.project;
  const paths = await ensureProjectRuntime(dataRoot, project.projectId);
  const sessionId = "sess-dev-dup";
  const taskId = "task-dev-dup";

  await addSession(paths, project.projectId, {
    sessionId,
    role: "dev_0",
    status: "idle",
    provider: "codex"
  });
  await createTask(paths, project.projectId, {
    taskId,
    taskKind: "EXECUTION",
    parentTaskId: `${project.projectId}-root`,
    rootTaskId: `${project.projectId}-root`,
    title: "Duplicate Guard Task",
    ownerRole: "dev_0",
    ownerSession: sessionId,
    state: "READY"
  });
  await appendEvent(paths, {
    projectId: project.projectId,
    eventType: "ORCHESTRATOR_DISPATCH_STARTED",
    source: "manager",
    sessionId,
    taskId,
    payload: {
      dispatchId: "dispatch-open-1",
      mode: "manual",
      dispatchKind: "task",
      messageId: "message-open-1",
      requestId: "request-open-1"
    }
  });

  const orchestrator = new OrchestratorService({
    dataRoot,
    providerRegistry: createProviderRegistry(),
    enabled: true,
    intervalMs: 3000,
    maxConcurrentDispatches: 2,
    sessionRunningTimeoutMs: 900000
  });

  const result = await orchestrator.dispatchProject(project.projectId, {
    mode: "manual",
    sessionId,
    taskId
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.outcome, "already_dispatched");
  assert.equal(result.results[0]?.reason, "duplicate_open_dispatch");

  const events = await listEvents(paths);
  const skipped = events.find(
    (item) =>
      item.eventType === "ORCHESTRATOR_DISPATCH_SKIPPED" && item.sessionId === sessionId && item.taskId === taskId
  );
  assert.ok(skipped);
  assert.equal((skipped?.payload as Record<string, unknown>).dispatchSkipReason, "duplicate_open_dispatch");
  const startedCount = events.filter(
    (item) =>
      item.eventType === "ORCHESTRATOR_DISPATCH_STARTED" && item.sessionId === sessionId && item.taskId === taskId
  ).length;
  assert.equal(startedCount, 1);
});
