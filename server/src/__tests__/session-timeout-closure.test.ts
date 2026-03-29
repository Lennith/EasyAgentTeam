import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { appendEvent, listEvents } from "../data/event-store.js";
import { createProject, ensureProjectRuntime } from "../data/project-store.js";
import { addSession, touchSession } from "../data/session-store.js";
import { OrchestratorService } from "../services/orchestrator/index.js";
import { createProviderRegistry } from "../services/provider-runtime.js";

test("running session timeout appends dispatch/run closure events", async () => {
  const previousTerminationTimeout = process.env.SESSION_PROCESS_TERMINATION_TIMEOUT_MS;
  const previousEscalationThreshold = process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD;
  process.env.SESSION_PROCESS_TERMINATION_TIMEOUT_MS = "200";
  process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD = "2";
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-session-timeout-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  try {
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
      currentTaskId: "task-timeout",
      lastRunId: "run-timeout-1",
      lastDispatchId: "dispatch-timeout-1"
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
      providerRegistry: createProviderRegistry(),
      enabled: true,
      intervalMs: 50,
      maxConcurrentDispatches: 1,
      sessionRunningTimeoutMs: 1_000
    });

    function isTimeoutRunFinishedEvent(item: { eventType: string; sessionId?: string; payload: unknown }) {
      if (item.eventType !== "CODEX_RUN_FINISHED" && item.eventType !== "MINIMAX_RUN_FINISHED") {
        return false;
      }
      if (item.sessionId !== "sess-timeout") {
        return false;
      }
      const payload = item.payload as Record<string, unknown>;
      const runId = typeof payload.runId === "string" ? payload.runId : "";
      if (runId && runId !== "run-timeout-1") {
        return false;
      }
      return payload.timedOut === true || payload.status === "timeout";
    }

    orchestrator.start();
    let events = await listEvents(paths);
    let timeoutEvent = events.find((item) => item.eventType === "SESSION_HEARTBEAT_TIMEOUT");
    let dispatchClosed = events.find(
      (item) =>
        (item.eventType === "ORCHESTRATOR_DISPATCH_FINISHED" || item.eventType === "ORCHESTRATOR_DISPATCH_FAILED") &&
        String((item.payload as Record<string, unknown>).dispatchId ?? "") === "dispatch-timeout-1"
    );
    let runFinished = events.find((item) => isTimeoutRunFinishedEvent(item));
    let timeoutRunnerEvent = events.find(
      (item) =>
        (item.eventType === "RUNNER_TIMEOUT_SOFT" || item.eventType === "RUNNER_TIMEOUT_ESCALATED") &&
        item.sessionId === "sess-timeout"
    );
    try {
      const deadline = Date.now() + 15_000;
      while ((!timeoutEvent || !runFinished || !timeoutRunnerEvent) && Date.now() < deadline) {
        await sleep(100);
        events = await listEvents(paths);
        timeoutEvent = events.find((item) => item.eventType === "SESSION_HEARTBEAT_TIMEOUT");
        dispatchClosed = events.find(
          (item) =>
            (item.eventType === "ORCHESTRATOR_DISPATCH_FINISHED" ||
              item.eventType === "ORCHESTRATOR_DISPATCH_FAILED") &&
            String((item.payload as Record<string, unknown>).dispatchId ?? "") === "dispatch-timeout-1"
        );
        runFinished = events.find((item) => isTimeoutRunFinishedEvent(item));
        timeoutRunnerEvent = events.find(
          (item) =>
            (item.eventType === "RUNNER_TIMEOUT_SOFT" || item.eventType === "RUNNER_TIMEOUT_ESCALATED") &&
            item.sessionId === "sess-timeout"
        );
      }
    } finally {
      orchestrator.stop();
    }
    events = await listEvents(paths);
    timeoutEvent = events.find((item) => item.eventType === "SESSION_HEARTBEAT_TIMEOUT");
    dispatchClosed = events.find(
      (item) =>
        (item.eventType === "ORCHESTRATOR_DISPATCH_FINISHED" || item.eventType === "ORCHESTRATOR_DISPATCH_FAILED") &&
        String((item.payload as Record<string, unknown>).dispatchId ?? "") === "dispatch-timeout-1"
    );
    if (!dispatchClosed) {
      dispatchClosed = events.find(
        (item) =>
          (item.eventType === "ORCHESTRATOR_DISPATCH_FINISHED" || item.eventType === "ORCHESTRATOR_DISPATCH_FAILED") &&
          item.sessionId === "sess-timeout" &&
          (item.payload as Record<string, unknown>).timedOut === true
      );
    }
    runFinished = events.find((item) => isTimeoutRunFinishedEvent(item));
    timeoutRunnerEvent = events.find(
      (item) =>
        (item.eventType === "RUNNER_TIMEOUT_SOFT" || item.eventType === "RUNNER_TIMEOUT_ESCALATED") &&
        item.sessionId === "sess-timeout"
    );
    assert.ok(timeoutEvent);
    if (dispatchClosed) {
      assert.equal((dispatchClosed.payload as Record<string, unknown>).timedOut, true);
    }

    assert.ok(timeoutRunnerEvent);

    assert.ok(runFinished);
    assert.equal((runFinished?.payload as Record<string, unknown>).timedOut, true);
    assert.equal((runFinished?.payload as Record<string, unknown>).status, "timeout");

    const terminationAttempted = events.find(
      (item) => item.eventType === "SESSION_PROCESS_TERMINATION_ATTEMPTED" && item.sessionId === "sess-timeout"
    );
    assert.ok(terminationAttempted);
  } finally {
    if (previousTerminationTimeout === undefined) {
      delete process.env.SESSION_PROCESS_TERMINATION_TIMEOUT_MS;
    } else {
      process.env.SESSION_PROCESS_TERMINATION_TIMEOUT_MS = previousTerminationTimeout;
    }
    if (previousEscalationThreshold === undefined) {
      delete process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD;
    } else {
      process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD = previousEscalationThreshold;
    }
  }
});
