import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowRepositoryBundle } from "../data/repository/workflow/repository-bundle.js";
import type {
  WorkflowManagerToAgentMessage,
  WorkflowRunRecord,
  WorkflowRunRuntimeState,
  WorkflowSessionRecord
} from "../domain/models.js";
import { OrchestratorSingleFlightGate } from "../services/orchestrator/shared/kernel/single-flight.js";
import { WorkflowDispatchSelectionAdapter } from "../services/orchestrator/workflow/workflow-dispatch-selection-adapter.js";

function createRun(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId: overrides.runId ?? "run_alpha",
    name: overrides.name ?? "Run Alpha",
    description: overrides.description ?? "Selection adapter test",
    workspacePath: overrides.workspacePath ?? "D:\\AgentWorkSpace\\RunAlpha",
    createdAt: overrides.createdAt ?? "2026-03-28T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-28T10:00:00.000Z",
    status: overrides.status ?? "running",
    autoDispatchEnabled: overrides.autoDispatchEnabled ?? true,
    autoDispatchRemaining: overrides.autoDispatchRemaining ?? 3,
    tasks: overrides.tasks ?? [
      {
        taskId: "task_a",
        ownerRole: "dev",
        resolvedTitle: "Implement task A",
        parentTaskId: null,
        dependencies: [],
        acceptance: [],
        artifacts: []
      }
    ],
    routeTable: overrides.routeTable,
    taskAssignRouteTable: overrides.taskAssignRouteTable,
    roleSessionMap: overrides.roleSessionMap ?? {}
  } as unknown as WorkflowRunRecord;
}

function createRuntime(
  states: Array<{ taskId: string; state: string; blockedBy?: string[] }>
): WorkflowRunRuntimeState {
  return {
    runId: "run_alpha",
    status: "running",
    active: true,
    updatedAt: "2026-03-28T10:00:00.000Z",
    counters: {
      total: states.length,
      planned: 0,
      ready: states.filter((item) => item.state === "READY").length,
      dispatched: states.filter((item) => item.state === "DISPATCHED").length,
      inProgress: states.filter((item) => item.state === "IN_PROGRESS").length,
      mayBeDone: states.filter((item) => item.state === "MAY_BE_DONE").length,
      blocked: states.filter((item) => item.state === "BLOCKED_DEP").length,
      done: states.filter((item) => item.state === "DONE").length,
      canceled: states.filter((item) => item.state === "CANCELED").length
    },
    tasks: states.map((item) => ({
      taskId: item.taskId,
      state: item.state,
      blockedBy: item.blockedBy ?? [],
      blockedReasons: [],
      transitions: [],
      lastSummary: null,
      lastTransitionAt: "2026-03-28T10:00:00.000Z"
    }))
  } as unknown as WorkflowRunRuntimeState;
}

function createSession(overrides: Partial<WorkflowSessionRecord> = {}): WorkflowSessionRecord {
  return {
    sessionId: overrides.sessionId ?? "session_dev",
    runId: overrides.runId ?? "run_alpha",
    role: overrides.role ?? "dev",
    status: overrides.status ?? "idle",
    provider: overrides.provider ?? "minimax",
    createdAt: overrides.createdAt ?? "2026-03-28T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-28T10:00:00.000Z",
    lastActiveAt: overrides.lastActiveAt ?? "2026-03-28T10:00:00.000Z",
    cooldownUntil: overrides.cooldownUntil,
    providerSessionId: overrides.providerSessionId,
    currentTaskId: overrides.currentTaskId,
    lastDispatchId: overrides.lastDispatchId,
    lastDispatchedAt: overrides.lastDispatchedAt,
    lastDispatchedMessageId: overrides.lastDispatchedMessageId,
    errorStreak: overrides.errorStreak,
    timeoutStreak: overrides.timeoutStreak,
    lastFailureAt: overrides.lastFailureAt,
    lastFailureKind: overrides.lastFailureKind
  } as unknown as WorkflowSessionRecord;
}

function createMessage(messageId: string, taskId: string): WorkflowManagerToAgentMessage {
  return {
    envelope: {
      message_id: messageId,
      run_id: "run_alpha",
      timestamp: "2026-03-28T10:00:00.000Z",
      sender: { type: "system", role: "manager", session_id: "manager-system" },
      via: { type: "manager" },
      intent: "MANAGER_MESSAGE",
      priority: "normal",
      correlation: { request_id: `request-${messageId}`, task_id: taskId },
      accountability: {
        owner_role: "dev",
        report_to: { role: "manager", session_id: "manager-system" },
        expect: "TASK_REPORT"
      },
      dispatch_policy: "fixed_session"
    },
    body: {
      messageType: "MANAGER_MESSAGE",
      mode: "CHAT",
      content: "message",
      taskId
    }
  };
}

function createRepositories(options: {
  inboxByRole?: Record<string, WorkflowManagerToAgentMessage[]>;
  events?: Array<Record<string, unknown>>;
}) {
  const appendedEvents: Array<Record<string, unknown>> = [];
  const repositories = {
    inbox: {
      listInboxMessages: async (_runId: string, role: string) => options.inboxByRole?.[role] ?? []
    },
    events: {
      listEvents: async () => (options.events ?? []) as Array<any>,
      appendEvent: async (_runId: string, event: Record<string, unknown>) => {
        appendedEvents.push(event);
      }
    }
  } as unknown as WorkflowRepositoryBundle;
  return { repositories, appendedEvents };
}

test("workflow dispatch selection resolves role and session for ready task", async () => {
  const run = createRun();
  const runtime = createRuntime([{ taskId: "task_a", state: "READY" }]);
  const session = createSession();
  const { repositories } = createRepositories({});
  const adapter = new WorkflowDispatchSelectionAdapter({
    repositories,
    inFlightDispatchSessionKeys: new OrchestratorSingleFlightGate(),
    buildRunSessionKey: (runId, sessionId) => `${runId}:${sessionId}`,
    resolveAuthoritativeSession: async () => session
  });

  const result = await adapter.select(
    { run, runtime, sessions: [session] },
    { force: false, onlyIdle: false, requestId: "request-1", remainingBudget: 3 }
  );

  assert.equal(result.status, "selected");
  if (result.status !== "selected") {
    return;
  }
  assert.equal(result.selection.role, "dev");
  assert.equal(result.selection.taskId, "task_a");
  assert.equal(result.selection.dispatchKind, "task");
});

test("workflow dispatch selection reports busy when session is cooling down", async () => {
  const run = createRun();
  const runtime = createRuntime([{ taskId: "task_a", state: "READY" }]);
  const session = createSession({
    cooldownUntil: "2099-03-28T10:00:00.000Z"
  });
  const { repositories } = createRepositories({});
  const adapter = new WorkflowDispatchSelectionAdapter({
    repositories,
    inFlightDispatchSessionKeys: new OrchestratorSingleFlightGate(),
    buildRunSessionKey: (runId, sessionId) => `${runId}:${sessionId}`,
    resolveAuthoritativeSession: async () => session
  });

  const result = await adapter.select(
    { run, runtime, sessions: [session] },
    { force: false, onlyIdle: false, requestId: "request-2", remainingBudget: 3 }
  );

  assert.equal(result.status, "none");
  if (result.status !== "none") {
    return;
  }
  assert.equal(result.busyFound, true);
});

test("workflow dispatch selection skips duplicate open task dispatch", async () => {
  const run = createRun();
  const runtime = createRuntime([{ taskId: "task_a", state: "READY" }]);
  const session = createSession();
  const openDispatchEvents = [
    {
      eventType: "ORCHESTRATOR_DISPATCH_STARTED",
      createdAt: "2026-03-28T10:00:00.000Z",
      taskId: "task_a",
      sessionId: "session_dev",
      payload: { dispatchId: "dispatch-open", dispatchKind: "task" }
    }
  ];
  const { repositories, appendedEvents } = createRepositories({ events: openDispatchEvents });
  const adapter = new WorkflowDispatchSelectionAdapter({
    repositories,
    inFlightDispatchSessionKeys: new OrchestratorSingleFlightGate(),
    buildRunSessionKey: (runId, sessionId) => `${runId}:${sessionId}`,
    resolveAuthoritativeSession: async () => session
  });

  const result = await adapter.select(
    { run, runtime, sessions: [session] },
    { force: false, onlyIdle: false, requestId: "request-3", remainingBudget: 3 }
  );

  assert.equal(result.status, "skipped");
  if (result.status !== "skipped") {
    return;
  }
  assert.equal(result.result.outcome, "already_dispatched");
  assert.equal(appendedEvents.length, 1);
});

test("workflow dispatch selection blocks auto dispatch when budget is exhausted", async () => {
  const run = createRun({ autoDispatchEnabled: true });
  const runtime = createRuntime([{ taskId: "task_a", state: "READY" }]);
  const session = createSession();
  const { repositories } = createRepositories({});
  const adapter = new WorkflowDispatchSelectionAdapter({
    repositories,
    inFlightDispatchSessionKeys: new OrchestratorSingleFlightGate(),
    buildRunSessionKey: (runId, sessionId) => `${runId}:${sessionId}`,
    resolveAuthoritativeSession: async () => session
  });

  const result = await adapter.select(
    { run, runtime, sessions: [session] },
    { force: false, onlyIdle: false, requestId: "request-4", remainingBudget: 0 }
  );

  assert.equal(result.status, "skipped");
  if (result.status !== "skipped") {
    return;
  }
  assert.equal(result.result.outcome, "invalid_target");
  assert.equal(result.result.reason, "auto dispatch budget exhausted");
});

test("workflow dispatch selection allows force redispatch for dispatched task", async () => {
  const run = createRun();
  const runtime = createRuntime([{ taskId: "task_a", state: "DISPATCHED" }]);
  const session = createSession();
  const { repositories } = createRepositories({
    inboxByRole: { dev: [createMessage("msg-1", "task_a")] }
  });
  const adapter = new WorkflowDispatchSelectionAdapter({
    repositories,
    inFlightDispatchSessionKeys: new OrchestratorSingleFlightGate(),
    buildRunSessionKey: (runId, sessionId) => `${runId}:${sessionId}`,
    resolveAuthoritativeSession: async () => session
  });

  const result = await adapter.select(
    { run, runtime, sessions: [session] },
    { force: true, onlyIdle: false, requestId: "request-5", remainingBudget: 0, taskId: "task_a" }
  );

  assert.equal(result.status, "selected");
  if (result.status !== "selected") {
    return;
  }
  assert.equal(result.selection.taskId, "task_a");
});
