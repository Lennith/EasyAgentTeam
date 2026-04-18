import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryProjectFixture } from "./helpers/project-orchestrator-fixtures.js";
import { ProjectCompletionService } from "../services/orchestrator/project/project-completion-service.js";

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
