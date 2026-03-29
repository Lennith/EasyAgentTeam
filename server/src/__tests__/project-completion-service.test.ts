import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryProjectFixture } from "./helpers/project-orchestrator-fixtures.js";
import { ProjectCompletionService } from "../services/orchestrator/project-completion-service.js";

function createCompletionService(fixture: ReturnType<typeof createMemoryProjectFixture>) {
  return new ProjectCompletionService({
    dataRoot: fixture.dataRoot,
    repositories: fixture.repositories,
    lastObservabilityEventAt: new Map<string, number>()
  });
}

test("project completion service removes inbox messages for terminal tasks", async () => {
  const fixture = createMemoryProjectFixture("completion-cleanup");
  try {
    const created = await fixture.createProject("completion-cleanup-project");
    await fixture.createRootAndExecutionTask(created.project.projectId, "dev", "task-done");
    await fixture.repositories.taskboard.patchTask(created.paths, created.project.projectId, "task-done", {
      state: "DONE"
    });
    await fixture.repositories.inbox.appendInboxMessage(created.paths, "dev", {
      envelope: {
        message_id: "msg-done",
        project_id: created.project.projectId,
        timestamp: "2026-03-28T00:00:00.000Z",
        sender: { type: "system", role: "manager", session_id: "manager-system" },
        via: { type: "manager" },
        intent: "TASK_ASSIGNMENT",
        priority: "normal",
        correlation: { request_id: "req-1", task_id: "task-done" },
        accountability: {
          owner_role: "dev",
          report_to: { role: "manager", session_id: "manager-system" },
          expect: "TASK_REPORT"
        },
        dispatch_policy: "fixed_session"
      },
      body: {
        messageType: "TASK_ASSIGNMENT",
        taskId: "task-done"
      }
    } as any);

    const service = createCompletionService(fixture);
    const removed = await service.cleanupCompletedTaskMessages(created.paths, created.project.projectId, "dev");
    const inbox = await fixture.repositories.inbox.listInboxMessages(created.paths, "dev");

    assert.equal(removed, 1);
    assert.equal(inbox.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("project completion service marks task as MAY_BE_DONE when threshold and valid output are met", async () => {
  const fixture = createMemoryProjectFixture("completion-maybedone");
  try {
    const created = await fixture.createProject("completion-maybedone-project");
    await fixture.createRootAndExecutionTask(created.project.projectId, "dev", "task-progress");
    await fixture.repositories.taskboard.patchTask(created.paths, created.project.projectId, "task-progress", {
      lastSummary: "Substantial progress summary"
    });
    for (let index = 0; index < 5; index += 1) {
      await fixture.repositories.events.appendEvent(created.paths, {
        projectId: created.project.projectId,
        eventType: "ORCHESTRATOR_DISPATCH_STARTED",
        source: "manager",
        sessionId: "session-dev",
        taskId: "task-progress",
        payload: {
          dispatchId: `dispatch-${index}`,
          dispatchKind: "task",
          createdAt: `2026-03-28T00:00:0${index}.000Z`
        }
      });
    }

    const service = createCompletionService(fixture);
    await service.checkAndMarkMayBeDone(created.project, created.paths);

    const task = await fixture.repositories.taskboard.getTask(
      created.paths,
      created.project.projectId,
      "task-progress"
    );
    const events = await fixture.repositories.events.listEvents(created.paths);
    assert.equal(task?.state, "MAY_BE_DONE");
    assert.equal(
      events.some((event) => event.eventType === "TASK_MAY_BE_DONE_MARKED"),
      true
    );
  } finally {
    fixture.cleanup();
  }
});

test("project completion service keeps terminal tasks terminal even when may-be-done conditions are met", async () => {
  const fixture = createMemoryProjectFixture("completion-terminal");
  try {
    const created = await fixture.createProject("completion-terminal-project");
    await fixture.createRootAndExecutionTask(created.project.projectId, "dev", "task-terminal");
    await fixture.repositories.taskboard.patchTask(created.paths, created.project.projectId, "task-terminal", {
      state: "DONE",
      lastSummary: "Already done"
    });
    for (let index = 0; index < 5; index += 1) {
      await fixture.repositories.events.appendEvent(created.paths, {
        projectId: created.project.projectId,
        eventType: "ORCHESTRATOR_DISPATCH_STARTED",
        source: "manager",
        sessionId: "session-dev",
        taskId: "task-terminal",
        payload: {
          dispatchId: `dispatch-terminal-${index}`,
          dispatchKind: "task"
        }
      });
    }

    const service = createCompletionService(fixture);
    await service.checkAndMarkMayBeDone(created.project, created.paths);

    const task = await fixture.repositories.taskboard.getTask(
      created.paths,
      created.project.projectId,
      "task-terminal"
    );
    assert.equal(task?.state, "DONE");
  } finally {
    fixture.cleanup();
  }
});
