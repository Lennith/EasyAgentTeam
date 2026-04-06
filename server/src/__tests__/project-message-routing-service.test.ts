import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryProjectFixture } from "./helpers/project-orchestrator-fixtures.js";
import {
  deliverProjectMessage,
  routeProjectManagerMessage,
  routeProjectTaskAssignmentMessage
} from "../services/orchestrator/project/project-message-routing-service.js";
import { buildTaskAssignmentMessageForTask } from "../services/task-actions/shared.js";

test("project deliver message uses shared template and bootstraps missing target session", async () => {
  const fixture = createMemoryProjectFixture("project-deliver-message");
  try {
    const created = await fixture.createProject("project-deliver-message");

    await fixture.repositories.taskboard.createTask(created.paths, created.project.projectId, {
      taskId: "root-1",
      taskKind: "PROJECT_ROOT",
      title: "Root",
      ownerRole: "manager"
    });
    const task = await fixture.repositories.taskboard.createTask(created.paths, created.project.projectId, {
      taskId: "task-a",
      taskKind: "EXECUTION",
      parentTaskId: "root-1",
      rootTaskId: "root-1",
      title: "Implement A",
      ownerRole: "dev",
      state: "READY"
    });
    const assignmentMessage = buildTaskAssignmentMessageForTask(created.project, task);

    const delivered = await deliverProjectMessage({
      dataRoot: fixture.dataRoot,
      project: created.project,
      paths: created.paths,
      message: assignmentMessage,
      targetRole: "dev"
    });

    assert.equal(delivered.sessionExisted, false);
    assert.equal(delivered.sessionId.startsWith("session-dev-"), true);

    const session = await fixture.repositories.sessions.getSession(
      created.paths,
      created.project.projectId,
      delivered.sessionId
    );
    assert.ok(session);
    assert.equal(session?.role, "dev");

    const inbox = await fixture.repositories.inbox.listInboxMessages(created.paths, "dev", 20);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.body?.messageType, "TASK_ASSIGNMENT");

    const events = await fixture.repositories.events.listEvents(created.paths);
    assert.equal(
      events.some((event) => event.eventType === "MESSAGE_ROUTED"),
      false
    );
  } finally {
    fixture.cleanup();
  }
});

test("project manager message routing uses shared template and appends route events", async () => {
  const fixture = createMemoryProjectFixture("project-route-manager-message");
  try {
    const created = await fixture.createProject("project-route-manager-message");
    await fixture.repositories.sessions.addSession(created.paths, created.project.projectId, {
      sessionId: "session-dev-01",
      role: "dev",
      status: "idle"
    });

    const routed = await routeProjectManagerMessage({
      dataRoot: fixture.dataRoot,
      project: created.project,
      paths: created.paths,
      fromAgent: "manager",
      fromSessionId: "manager-system",
      messageType: "MANAGER_MESSAGE",
      toRole: "dev",
      toSessionId: "session-dev-01",
      requestId: "req-manager-route-1",
      parentRequestId: "parent-manager-route-1",
      content: "please continue with task planning"
    });

    assert.equal(routed.requestId, "req-manager-route-1");
    assert.equal(routed.parentRequestId, "parent-manager-route-1");
    assert.equal(routed.messageType, "MANAGER_MESSAGE");
    assert.equal(routed.toRole, "dev");
    assert.equal(routed.resolvedSessionId, "session-dev-01");

    const inbox = await fixture.repositories.inbox.listInboxMessages(created.paths, "dev", 20);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.body?.messageType, "MANAGER_MESSAGE");
    assert.equal(inbox[0]?.body?.content, "please continue with task planning");

    const events = await fixture.repositories.events.listEvents(created.paths);
    const receivedEvent = events.find((event) => event.eventType === "USER_MESSAGE_RECEIVED");
    const routedEvent = events.find((event) => event.eventType === "MESSAGE_ROUTED");
    assert.ok(receivedEvent);
    assert.ok(routedEvent);
    assert.equal((receivedEvent?.payload as Record<string, unknown>)?.requestId, "req-manager-route-1");
    assert.equal((routedEvent?.payload as Record<string, unknown>)?.requestId, "req-manager-route-1");
    assert.equal((routedEvent?.payload as Record<string, unknown>)?.resolvedSessionId, "session-dev-01");
  } finally {
    fixture.cleanup();
  }
});

test("project task assignment routing uses shared skeleton and emits manager routed event", async () => {
  const fixture = createMemoryProjectFixture("project-route-task-assignment");
  try {
    const created = await fixture.createProject("project-route-task-assignment");
    await fixture.repositories.sessions.addSession(created.paths, created.project.projectId, {
      sessionId: "session-dev-01",
      role: "dev",
      status: "idle"
    });

    await fixture.repositories.taskboard.createTask(created.paths, created.project.projectId, {
      taskId: "root-1",
      taskKind: "PROJECT_ROOT",
      title: "Root",
      ownerRole: "manager"
    });

    const task = await fixture.repositories.taskboard.createTask(created.paths, created.project.projectId, {
      taskId: "task-a",
      taskKind: "EXECUTION",
      parentTaskId: "root-1",
      rootTaskId: "root-1",
      title: "Implement A",
      state: "READY",
      ownerRole: "dev",
      ownerSession: "session-dev-01",
      priority: 2,
      writeSet: ["src/a.ts"],
      dependencies: [],
      acceptance: ["tests pass"],
      artifacts: ["result.md"]
    });
    const assignmentMessage = buildTaskAssignmentMessageForTask(created.project, task);

    const routed = await routeProjectTaskAssignmentMessage({
      dataRoot: fixture.dataRoot,
      project: created.project,
      paths: created.paths,
      fromAgent: "manager",
      fromSessionId: "manager-system",
      requestId: "req-route-1",
      taskId: "task-a",
      toRole: "dev",
      toSessionId: "session-dev-01",
      message: assignmentMessage
    });

    assert.equal(routed.messageType, "TASK_ASSIGNMENT");
    assert.equal(routed.taskId, "task-a");
    assert.equal(routed.toRole, "dev");
    assert.equal(routed.resolvedSessionId, "session-dev-01");

    const inbox = await fixture.repositories.inbox.listInboxMessages(created.paths, "dev", 20);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.body?.messageType, "TASK_ASSIGNMENT");

    const events = await fixture.repositories.events.listEvents(created.paths);
    const routedEvent = events.find((event) => event.eventType === "MANAGER_MESSAGE_ROUTED");
    assert.ok(routedEvent);
    assert.equal((routedEvent?.payload as Record<string, unknown>)?.type, "TASK_ASSIGNMENT");
    assert.equal((routedEvent?.payload as Record<string, unknown>)?.requestId, "req-route-1");
  } finally {
    fixture.cleanup();
  }
});
