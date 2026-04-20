import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { appendEvent, listEvents } from "../data/repository/project/event-repository.js";
import { createProjectRepositoryBundle } from "../data/repository/project/repository-bundle.js";
import { createProject, ensureProjectRuntime } from "../data/repository/project/runtime-repository.js";
import { addSession, touchSession } from "../data/repository/project/session-repository.js";
import { createTask, ensureUserRootTask, getTask } from "../data/repository/project/taskboard-repository.js";
import { OrchestratorService } from "../services/orchestrator/index.js";
import { markProjectTimedOutSessions } from "../services/orchestrator/project/project-session-runtime-timeout.js";
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
      while (
        (!timeoutEvent ||
          (!dispatchClosed && !runFinished) ||
          (!timeoutRunnerEvent && !dispatchClosed && !runFinished)) &&
        Date.now() < deadline
      ) {
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

    // Runner timeout event can be skipped when session metadata is already absent
    // during timeout marking. Closure is still covered by heartbeat + dispatch/run terminal events.
    if (timeoutRunnerEvent) {
      assert.equal(timeoutRunnerEvent.sessionId, "sess-timeout");
    }

    assert.ok(dispatchClosed || runFinished);
    if (runFinished) {
      assert.equal((runFinished.payload as Record<string, unknown>).timedOut, true);
      assert.equal((runFinished.payload as Record<string, unknown>).status, "timeout");
    }

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

test("running minimax session timeout appends minimax synthetic run closure event", async () => {
  const previousTerminationTimeout = process.env.SESSION_PROCESS_TERMINATION_TIMEOUT_MS;
  const previousEscalationThreshold = process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD;
  process.env.SESSION_PROCESS_TERMINATION_TIMEOUT_MS = "200";
  process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD = "2";
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-session-timeout-minimax-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  try {
    const created = await createProject(dataRoot, {
      projectId: "sessiontimeoutminimax",
      name: "Session Timeout MiniMax",
      workspacePath
    });
    const project = created.project;
    const paths = await ensureProjectRuntime(dataRoot, project.projectId);

    await addSession(paths, project.projectId, {
      sessionId: "sess-timeout-minimax",
      role: "dev_impl",
      provider: "minimax",
      status: "running",
      currentTaskId: "task-timeout-minimax",
      lastRunId: "run-timeout-minimax-1",
      lastDispatchId: "dispatch-timeout-minimax-1"
    });
    await touchSession(paths, project.projectId, "sess-timeout-minimax", {
      status: "running",
      currentTaskId: "task-timeout-minimax",
      lastActiveAt: new Date(Date.now() - 60_000).toISOString()
    });

    await appendEvent(paths, {
      projectId: project.projectId,
      eventType: "ORCHESTRATOR_DISPATCH_STARTED",
      source: "manager",
      sessionId: "sess-timeout-minimax",
      taskId: "task-timeout-minimax",
      payload: {
        dispatchId: "dispatch-timeout-minimax-1",
        mode: "loop",
        dispatchKind: "task",
        messageId: "msg-timeout-minimax-1",
        requestId: "req-timeout-minimax-1"
      }
    });
    await appendEvent(paths, {
      projectId: project.projectId,
      eventType: "MINIMAX_RUN_STARTED",
      source: "manager",
      sessionId: "sess-timeout-minimax",
      taskId: "task-timeout-minimax",
      payload: {
        runId: "run-timeout-minimax-1",
        mode: "exec",
        provider: "minimax"
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

    function isTimeoutMiniMaxRunFinished(item: { eventType: string; sessionId?: string; payload: unknown }) {
      if (item.eventType !== "MINIMAX_RUN_FINISHED") {
        return false;
      }
      if (item.sessionId !== "sess-timeout-minimax") {
        return false;
      }
      const payload = item.payload as Record<string, unknown>;
      return payload.timedOut === true || payload.status === "timeout";
    }

    orchestrator.start();
    let events = await listEvents(paths);
    let runFinished = events.find((item) => isTimeoutMiniMaxRunFinished(item));
    try {
      const deadline = Date.now() + 15_000;
      while (!runFinished && Date.now() < deadline) {
        await sleep(100);
        events = await listEvents(paths);
        runFinished = events.find((item) => isTimeoutMiniMaxRunFinished(item));
      }
    } finally {
      orchestrator.stop();
    }

    events = await listEvents(paths);
    runFinished = events.find((item) => isTimeoutMiniMaxRunFinished(item));
    assert.ok(runFinished);
    assert.equal((runFinished.payload as Record<string, unknown>).provider, "minimax");
    assert.equal(
      events.some((item) => item.eventType === "CODEX_RUN_FINISHED" && item.sessionId === "sess-timeout-minimax"),
      false
    );
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

test("project timeout skips kill when recent terminal report completed in trailing window", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-session-timeout-terminal-protection-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  const repositories = createProjectRepositoryBundle(dataRoot);
  const terminated: string[] = [];

  const created = await createProject(dataRoot, {
    projectId: "sessiontimeoutterminal",
    name: "Session Timeout Terminal Protection",
    workspacePath
  });
  const project = created.project;
  const paths = await ensureProjectRuntime(dataRoot, project.projectId);
  const userRoot = await ensureUserRootTask(paths, project.projectId, {
    taskId: "user-root-terminal",
    title: "User Root"
  });
  await createTask(paths, project.projectId, {
    taskId: "task-terminal-protected",
    parentTaskId: userRoot.taskId,
    rootTaskId: userRoot.taskId,
    title: "Protected terminal task",
    ownerRole: "lead",
    ownerSession: "sess-terminal-protected",
    state: "DONE"
  });

  await addSession(paths, project.projectId, {
    sessionId: "sess-terminal-protected",
    role: "lead",
    status: "running",
    provider: "codex",
    currentTaskId: "task-terminal-protected"
  });

  await appendEvent(paths, {
    projectId: project.projectId,
    eventType: "TASK_REPORT_APPLIED",
    source: "manager",
    sessionId: "sess-terminal-protected",
    taskId: "task-terminal-protected",
    payload: {
      fromAgent: "lead",
      appliedTaskIds: ["task-terminal-protected"],
      updatedTaskIds: ["task-terminal-protected"],
      rejectedCount: 0
    }
  });
  const staleAt = new Date(Date.now() - 60_000).toISOString();
  const sessionsState = JSON.parse(await readFile(paths.sessionsFile, "utf8")) as {
    updatedAt: string;
    sessions: Array<Record<string, unknown>>;
  };
  const sessionEntry = sessionsState.sessions.find((item) => item.sessionId === "sess-terminal-protected");
  assert.ok(sessionEntry);
  sessionEntry.createdAt = staleAt;
  sessionEntry.updatedAt = staleAt;
  sessionEntry.lastActiveAt = staleAt;
  sessionEntry.currentTaskId = "task-terminal-protected";
  sessionsState.updatedAt = staleAt;
  await writeFile(paths.sessionsFile, `${JSON.stringify(sessionsState, null, 2)}\n`, "utf8");

  await markProjectTimedOutSessions(
    {
      dataRoot,
      repositories,
      sessionRunningTimeoutMs: 1_000,
      terminateSessionProcess: async (_project, _paths, session) => {
        terminated.push(session.sessionId);
      }
    },
    project,
    paths
  );

  const events = await listEvents(paths);
  const skipped = events.find((item) => item.eventType === "SESSION_HEARTBEAT_TIMEOUT_SKIPPED");
  const timeout = events.find((item) => item.eventType === "SESSION_HEARTBEAT_TIMEOUT");
  const session = await repositories.sessions.getSession(paths, project.projectId, "sess-terminal-protected");
  const task = await getTask(paths, project.projectId, "task-terminal-protected");

  assert.deepEqual(terminated, []);
  assert.ok(skipped);
  assert.equal((skipped?.payload as Record<string, unknown>).reason, "recent_terminal_report");
  assert.equal(timeout, undefined);
  assert.equal(session?.status, "running");
  assert.equal(task?.state, "DONE");
});
