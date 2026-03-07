import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { appendEvent, listEvents } from "../data/event-store.js";
import { createProject, ensureProjectRuntime } from "../data/project-store.js";
import { addSession, touchSession } from "../data/session-store.js";
import { OrchestratorService } from "../services/orchestrator-service.js";

test("running session timeout appends dispatch/run closure events", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-session-timeout-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  const created = await createProject(dataRoot, {
    projectId: "sessiontimeout",
    name: "Session Timeout",
    workspacePath
  });
  const project = created.project;
  const paths = await ensureProjectRuntime(dataRoot, project.projectId);

  await addSession(paths, project.projectId, {
    sessionId: "sess-timeout",
    role: "dev_impl",
    status: "running",
    currentTaskId: "task-timeout"
  });
  await touchSession(paths, project.projectId, "sess-timeout", {
    status: "running",
    currentTaskId: "task-timeout",
    lastActiveAt: new Date(Date.now() - 60_000).toISOString()
  });

  await appendEvent(paths, {
    projectId: project.projectId,
    eventType: "ORCHESTRATOR_DISPATCH_STARTED",
    source: "manager",
    sessionId: "sess-timeout",
    taskId: "task-timeout",
    payload: {
      dispatchId: "dispatch-timeout-1",
      mode: "loop",
      dispatchKind: "task",
      messageId: "msg-timeout-1",
      requestId: "req-timeout-1"
    }
  });
  await appendEvent(paths, {
    projectId: project.projectId,
    eventType: "CODEX_RUN_STARTED",
    source: "manager",
    sessionId: "sess-timeout",
    taskId: "task-timeout",
    payload: {
      runId: "run-timeout-1",
      mode: "exec",
      provider: "codex",
      pid: 999999
    }
  });

  const orchestrator = new OrchestratorService({
    dataRoot,
    enabled: true,
    intervalMs: 50,
    maxConcurrentDispatches: 1,
    sessionRunningTimeoutMs: 1_000
  });

  orchestrator.start();
  let events = await listEvents(paths);
  let timeoutEvent = events.find((item) => item.eventType === "SESSION_HEARTBEAT_TIMEOUT");
  try {
    const deadline = Date.now() + 2_000;
    while (!timeoutEvent && Date.now() < deadline) {
      await sleep(100);
      events = await listEvents(paths);
      timeoutEvent = events.find((item) => item.eventType === "SESSION_HEARTBEAT_TIMEOUT");
    }
  } finally {
    orchestrator.stop();
  }
  assert.ok(timeoutEvent);

  const dispatchClosed = events.find(
    (item) =>
      (item.eventType === "ORCHESTRATOR_DISPATCH_FINISHED" || item.eventType === "ORCHESTRATOR_DISPATCH_FAILED") &&
      String((item.payload as Record<string, unknown>).dispatchId ?? "") === "dispatch-timeout-1"
  );
  assert.ok(dispatchClosed);
  assert.equal((dispatchClosed?.payload as Record<string, unknown>).timedOut, true);

  const timeoutSoft = events.find(
    (item) => item.eventType === "RUNNER_TIMEOUT_SOFT" && item.sessionId === "sess-timeout"
  );
  assert.ok(timeoutSoft);

  const runFinished = events.find(
    (item) =>
      item.eventType === "CODEX_RUN_FINISHED" &&
      String((item.payload as Record<string, unknown>).runId ?? "") === "run-timeout-1"
  );
  assert.ok(runFinished);
  assert.equal((runFinished?.payload as Record<string, unknown>).timedOut, true);
  assert.equal((runFinished?.payload as Record<string, unknown>).status, "timeout");

  const terminationAttempted = events.find(
    (item) => item.eventType === "SESSION_PROCESS_TERMINATION_ATTEMPTED" && item.sessionId === "sess-timeout"
  );
  assert.ok(terminationAttempted);
});
