import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryProjectFixture } from "./helpers/project-orchestrator-fixtures.js";
import { routeProjectTaskAssignmentMessage } from "../services/orchestrator/project-message-routing-service.js";
import { buildTaskAssignmentMessageForTask } from "../services/task-actions/shared.js";

test("project task assignment routing uses shared skeleton and emits manager routed event", async () => {
  const fixture = createMemoryProjectFixture("project-route-task-assignment");
  try {
    const created = await fixture.createProject("project-route-task-assignment");
    await fixture.repositories.sessions.addSession(created.paths, created.project.projectId, {
      sessionId: "session-dev-01",
      role: "dev",
      status: "idle"
    });

    const assignmentMessage = buildTaskAssignmentMessageForTask(created.project, {
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
      dependencies: ["task-prep"],
      acceptance: ["tests pass"],
      artifacts: ["result.md"],
      lastSummary: "please start"
    });

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
