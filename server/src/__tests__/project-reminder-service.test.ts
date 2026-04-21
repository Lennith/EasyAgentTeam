import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryProjectFixture } from "./helpers/project-orchestrator-fixtures.js";
import { ProjectReminderService } from "../services/orchestrator/project/project-reminder-service.js";

function createReminderService(
  fixture: ReturnType<typeof createMemoryProjectFixture>,
  dispatchCalls: Array<Record<string, unknown>>
) {
  return new ProjectReminderService({
    dataRoot: fixture.dataRoot,
    repositories: fixture.repositories,
    idleTimeoutMs: 60_000,
    reminderBackoffMultiplier: 2,
    reminderMaxIntervalMs: 1800000,
    reminderMaxCount: 5,
    autoReminderEnabled: true,
    dispatchProject: async (projectId, input) => {
      dispatchCalls.push({ projectId, ...input });
      return {
        projectId,
        mode: input.mode ?? "loop",
        results: [
          {
            sessionId: String(input.sessionId ?? "session-dev"),
            role: "dev",
            outcome: "no_message",
            dispatchKind: null
          }
        ]
      };
    }
  });
}

test("project reminder service triggers reminder, appends inbox/event, and redispatches", async () => {
  const fixture = createMemoryProjectFixture("reminder-trigger");
  const dispatchCalls: Array<Record<string, unknown>> = [];
  try {
    const created = await fixture.createProject("reminder-trigger-project");
    await fixture.createRootAndExecutionTask(created.project.projectId, "dev");
    await fixture.repositories.sessions.addSession(created.paths, created.project.projectId, {
      sessionId: "session-dev",
      role: "dev",
      status: "idle"
    });
    await fixture.repositories.projectRuntime.updateRoleReminderState(created.paths, created.project.projectId, "dev", {
      idleSince: "2000-01-01T00:00:00.000Z",
      reminderCount: 0,
      nextReminderAt: "2000-01-01T00:00:00.000Z",
      lastRoleState: "IDLE"
    });

    const service = createReminderService(fixture, dispatchCalls);
    await service.checkIdleRoles(created.project, created.paths);

    const inbox = await fixture.repositories.inbox.listInboxMessages(created.paths, "dev");
    const events = await fixture.repositories.events.listEvents(created.paths);
    assert.equal(inbox.length > 0, true);
    assert.equal(
      events.some((event) => event.eventType === "ORCHESTRATOR_ROLE_REMINDER_TRIGGERED"),
      true
    );
    assert.equal(
      events.some((event) => event.eventType === "ORCHESTRATOR_ROLE_REMINDER_REDISPATCH"),
      true
    );
    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0]?.taskId, "task_exec");
    assert.equal(dispatchCalls[0]?.onlyIdle, true);
  } finally {
    fixture.cleanup();
  }
});

test("project reminder service resets reminder state on manual action", async () => {
  const fixture = createMemoryProjectFixture("reminder-reset");
  try {
    const created = await fixture.createProject("reminder-reset-project");
    await fixture.repositories.projectRuntime.updateRoleReminderState(created.paths, created.project.projectId, "dev", {
      idleSince: "2026-03-28T00:00:00.000Z",
      reminderCount: 3,
      nextReminderAt: "2026-03-28T00:05:00.000Z",
      lastRoleState: "IDLE"
    });
    const service = createReminderService(fixture, []);
    await service.resetRoleReminderOnManualAction(created.project.projectId, "dev", "session_created");

    const state = await fixture.repositories.projectRuntime.getRoleReminderState(
      created.paths,
      created.project.projectId,
      "dev"
    );
    const events = await fixture.repositories.events.listEvents(created.paths);
    assert.equal(state?.reminderCount, 0);
    assert.equal(state?.lastRoleState, "INACTIVE");
    assert.equal(
      events.some((event) => event.eventType === "ORCHESTRATOR_ROLE_REMINDER_RESET"),
      true
    );
  } finally {
    fixture.cleanup();
  }
});

test("project reminder service does not trigger when next reminder is still in the future", async () => {
  const fixture = createMemoryProjectFixture("reminder-wait");
  const dispatchCalls: Array<Record<string, unknown>> = [];
  try {
    const created = await fixture.createProject("reminder-wait-project");
    await fixture.createRootAndExecutionTask(created.project.projectId, "dev");
    await fixture.repositories.sessions.addSession(created.paths, created.project.projectId, {
      sessionId: "session-dev",
      role: "dev",
      status: "idle"
    });
    await fixture.repositories.projectRuntime.updateRoleReminderState(created.paths, created.project.projectId, "dev", {
      idleSince: "2026-03-28T00:00:00.000Z",
      reminderCount: 1,
      nextReminderAt: "2999-01-01T00:00:00.000Z",
      lastRoleState: "IDLE"
    });

    const service = createReminderService(fixture, dispatchCalls);
    await service.checkIdleRoles(created.project, created.paths);

    const inbox = await fixture.repositories.inbox.listInboxMessages(created.paths, "dev");
    assert.equal(inbox.length, 0);
    assert.equal(dispatchCalls.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("project reminder service skips ancestor reminder when descendants are unresolved", async () => {
  const fixture = createMemoryProjectFixture("reminder-descendant-gate");
  const dispatchCalls: Array<Record<string, unknown>> = [];
  try {
    const created = await fixture.createProject("reminder-descendant-gate-project");
    await fixture.repositories.taskboard.createTask(created.paths, created.project.projectId, {
      taskId: "root",
      taskKind: "PROJECT_ROOT",
      title: "Root",
      ownerRole: "dev"
    });
    await fixture.repositories.taskboard.createTask(created.paths, created.project.projectId, {
      taskId: "task_parent",
      taskKind: "EXECUTION",
      parentTaskId: "root",
      rootTaskId: "root",
      title: "Parent Task",
      ownerRole: "dev",
      state: "READY"
    });
    await fixture.repositories.taskboard.createTask(created.paths, created.project.projectId, {
      taskId: "task_child",
      taskKind: "EXECUTION",
      parentTaskId: "task_parent",
      rootTaskId: "root",
      title: "Child Task",
      ownerRole: "qa",
      state: "IN_PROGRESS"
    });
    await fixture.repositories.sessions.addSession(created.paths, created.project.projectId, {
      sessionId: "session-dev",
      role: "dev",
      status: "idle"
    });
    await fixture.repositories.projectRuntime.updateRoleReminderState(created.paths, created.project.projectId, "dev", {
      idleSince: "2000-01-01T00:00:00.000Z",
      reminderCount: 0,
      nextReminderAt: "2000-01-01T00:00:00.000Z",
      lastRoleState: "IDLE"
    });

    const service = createReminderService(fixture, dispatchCalls);
    await service.checkIdleRoles(created.project, created.paths);

    const inbox = await fixture.repositories.inbox.listInboxMessages(created.paths, "dev");
    assert.equal(inbox.length, 0);
    assert.equal(dispatchCalls.length, 0);
  } finally {
    fixture.cleanup();
  }
});
