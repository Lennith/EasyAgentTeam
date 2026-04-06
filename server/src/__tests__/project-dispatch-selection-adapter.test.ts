import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectRepositoryBundle } from "../data/repository/project/repository-bundle.js";
import type {
  ManagerToAgentMessage,
  ProjectPaths,
  ProjectRecord,
  SessionRecord,
  TaskRecord
} from "../domain/models.js";
import { ProjectDispatchSelectionAdapter } from "../services/orchestrator/project/project-dispatch-selection-adapter.js";

function createTask(overrides: Partial<TaskRecord> & Pick<TaskRecord, "taskId" | "ownerRole" | "state">): TaskRecord {
  const now = "2026-03-28T10:00:00.000Z";
  return {
    taskId: overrides.taskId,
    taskKind: "EXECUTION",
    parentTaskId: overrides.parentTaskId ?? "root",
    rootTaskId: overrides.rootTaskId ?? "root",
    title: overrides.title ?? overrides.taskId,
    ownerRole: overrides.ownerRole,
    state: overrides.state,
    writeSet: overrides.writeSet ?? [],
    dependencies: overrides.dependencies ?? [],
    acceptance: overrides.acceptance ?? [],
    artifacts: overrides.artifacts ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    creatorRole: overrides.creatorRole,
    creatorSessionId: overrides.creatorSessionId,
    ownerSession: overrides.ownerSession,
    priority: overrides.priority,
    alert: overrides.alert,
    grantedAt: overrides.grantedAt,
    closedAt: overrides.closedAt,
    closeReportId: overrides.closeReportId,
    lastSummary: overrides.lastSummary
  };
}

function createMessage(messageId: string, taskId: string, content = "hello"): ManagerToAgentMessage {
  return {
    envelope: {
      message_id: messageId,
      project_id: "project_alpha",
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
      taskId,
      content
    }
  };
}

function createSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = "2026-03-28T10:00:00.000Z";
  return {
    schemaVersion: "1.0",
    sessionId: overrides.sessionId ?? "session_dev",
    projectId: overrides.projectId ?? "project_alpha",
    role: overrides.role ?? "dev",
    provider: overrides.provider ?? "minimax",
    status: overrides.status ?? "idle",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    lastActiveAt: overrides.lastActiveAt ?? now,
    providerSessionId: overrides.providerSessionId,
    currentTaskId: overrides.currentTaskId,
    lastInboxMessageId: overrides.lastInboxMessageId,
    lastDispatchedAt: overrides.lastDispatchedAt,
    agentPid: overrides.agentPid,
    pendingConfirmedMessages: overrides.pendingConfirmedMessages,
    confirmedMessageIds: overrides.confirmedMessageIds,
    idleSince: overrides.idleSince,
    reminderCount: overrides.reminderCount,
    nextReminderAt: overrides.nextReminderAt,
    timeoutStreak: overrides.timeoutStreak,
    errorStreak: overrides.errorStreak,
    lastFailureAt: overrides.lastFailureAt,
    lastFailureKind: overrides.lastFailureKind,
    lastRunId: overrides.lastRunId,
    lastDispatchId: overrides.lastDispatchId,
    cooldownUntil: overrides.cooldownUntil
  };
}

function createProject(): ProjectRecord {
  return {
    schemaVersion: "1.0",
    projectId: "project_alpha",
    name: "Project Alpha",
    workspacePath: "D:\\AgentWorkSpace\\ProjectAlpha",
    createdAt: "2026-03-28T10:00:00.000Z",
    updatedAt: "2026-03-28T10:00:00.000Z",
    roleMessageStatus: {
      dev: {
        confirmedMessageIds: [],
        pendingConfirmedMessages: []
      }
    }
  };
}

function createPaths(): ProjectPaths {
  return {
    projectRootDir: "D:\\data\\projects\\project_alpha",
    projectConfigFile: "D:\\data\\projects\\project_alpha\\project.json",
    collabDir: "D:\\data\\projects\\project_alpha\\collab",
    eventsFile: "D:\\data\\projects\\project_alpha\\events.jsonl",
    taskboardFile: "D:\\data\\projects\\project_alpha\\taskboard.json",
    sessionsFile: "D:\\data\\projects\\project_alpha\\sessions.json",
    roleRemindersFile: "D:\\data\\projects\\project_alpha\\role-reminders.json",
    locksDir: "D:\\data\\projects\\project_alpha\\locks",
    inboxDir: "D:\\data\\projects\\project_alpha\\inbox",
    outboxDir: "D:\\data\\projects\\project_alpha\\outbox",
    auditDir: "D:\\data\\projects\\project_alpha\\audit",
    agentOutputFile: "D:\\data\\projects\\project_alpha\\agent-output.json",
    promptsDir: "D:\\data\\projects\\project_alpha\\prompts"
  };
}

function createRepositories(options: {
  messages?: ManagerToAgentMessage[];
  tasks?: TaskRecord[];
  runnableTasks?: TaskRecord[];
  events?: Array<Record<string, unknown>>;
}) {
  const appendedEvents: Array<Record<string, unknown>> = [];
  const repositories = {
    inbox: {
      listInboxMessages: async () => options.messages ?? []
    },
    taskboard: {
      listRunnableTasksByRole: async () => [{ role: "dev", tasks: options.runnableTasks ?? [] }],
      listTasks: async () => options.tasks ?? []
    },
    events: {
      listEvents: async () => (options.events ?? []) as Array<any>,
      appendEvent: async (_paths: ProjectPaths, event: Record<string, unknown>) => {
        appendedEvents.push(event);
      }
    }
  } as unknown as ProjectRepositoryBundle;
  return { repositories, appendedEvents };
}

test("project dispatch selection picks explicit message candidate", async () => {
  const message = createMessage("msg-1", "task_a");
  const task = createTask({ taskId: "task_a", ownerRole: "dev", state: "IN_PROGRESS" });
  const { repositories } = createRepositories({
    messages: [message],
    tasks: [task],
    runnableTasks: []
  });
  const adapter = new ProjectDispatchSelectionAdapter(repositories);

  const result = await adapter.select(
    { project: createProject(), paths: createPaths(), session: createSession() },
    { mode: "manual", messageId: "msg-1" }
  );

  assert.equal(result.status, "selected");
  if (result.status !== "selected") {
    return;
  }
  assert.equal(result.selection.dispatchKind, "message");
  assert.equal(result.selection.messageId, "msg-1");
  assert.equal(result.selection.taskId, "task_a");
});

test("project dispatch selection allows force task dispatch on force-dispatchable state", async () => {
  const task = createTask({ taskId: "task_force", ownerRole: "dev", state: "IN_PROGRESS" });
  const { repositories } = createRepositories({
    tasks: [task],
    runnableTasks: []
  });
  const adapter = new ProjectDispatchSelectionAdapter(repositories);

  const result = await adapter.select(
    { project: createProject(), paths: createPaths(), session: createSession() },
    { mode: "manual", taskId: "task_force", force: true }
  );

  assert.equal(result.status, "selected");
  if (result.status !== "selected") {
    return;
  }
  assert.equal(result.selection.dispatchKind, "task");
  assert.equal(result.selection.taskId, "task_force");
});

test("project dispatch selection rejects dependency-gated task and appends skip event", async () => {
  const blocked = createTask({
    taskId: "task_blocked",
    ownerRole: "dev",
    state: "READY",
    dependencies: ["task_dep"]
  });
  const dep = createTask({
    taskId: "task_dep",
    ownerRole: "qa",
    state: "IN_PROGRESS"
  });
  const { repositories, appendedEvents } = createRepositories({
    tasks: [blocked, dep],
    runnableTasks: [blocked]
  });
  const adapter = new ProjectDispatchSelectionAdapter(repositories);

  const result = await adapter.select(
    { project: createProject(), paths: createPaths(), session: createSession() },
    { mode: "manual", taskId: "task_blocked" }
  );

  assert.equal(result.status, "skipped");
  if (result.status !== "skipped") {
    return;
  }
  assert.equal(result.result.outcome, "task_not_found");
  assert.equal(appendedEvents.length, 1);
  assert.equal((appendedEvents[0].payload as Record<string, unknown>).dispatchSkipReason, "dependency_gate_closed");
});

test("project dispatch selection skips duplicate open task dispatch", async () => {
  const task = createTask({ taskId: "task_dup", ownerRole: "dev", state: "READY" });
  const openDispatchEvents = [
    {
      eventType: "ORCHESTRATOR_DISPATCH_STARTED",
      createdAt: "2026-03-28T10:00:00.000Z",
      taskId: "task_dup",
      sessionId: "session_dev",
      payload: { dispatchId: "dispatch-open", dispatchKind: "task" }
    }
  ];
  const { repositories, appendedEvents } = createRepositories({
    tasks: [task],
    runnableTasks: [task],
    events: openDispatchEvents
  });
  const adapter = new ProjectDispatchSelectionAdapter(repositories);

  const result = await adapter.select(
    { project: createProject(), paths: createPaths(), session: createSession() },
    { mode: "manual" }
  );

  assert.equal(result.status, "skipped");
  if (result.status !== "skipped") {
    return;
  }
  assert.equal(result.result.outcome, "already_dispatched");
  assert.equal(result.result.reason, "duplicate_open_dispatch");
  assert.equal(appendedEvents.length, 1);
});

test("project dispatch selection honors onlyIdle gate", async () => {
  const task = createTask({ taskId: "task_idle", ownerRole: "dev", state: "READY" });
  const { repositories } = createRepositories({
    tasks: [task],
    runnableTasks: [task]
  });
  const adapter = new ProjectDispatchSelectionAdapter(repositories);

  const result = await adapter.select(
    { project: createProject(), paths: createPaths(), session: createSession({ status: "running" }) },
    { mode: "manual", onlyIdle: true }
  );

  assert.equal(result.status, "skipped");
  if (result.status !== "skipped") {
    return;
  }
  assert.equal(result.result.outcome, "session_busy");
});
