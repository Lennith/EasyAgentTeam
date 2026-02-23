import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { appendEvent, listEvents } from "../data/event-store.js";
import { createProject } from "../data/project-store.js";
import {
  createTask,
  ensureUserRootTask,
  readTaskboard,
  recomputeRunnableStates,
  updateTaskboardFromTaskReport
} from "../data/taskboard-store.js";

test("event append is append-only and readable", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step1-event-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "eventtest",
    name: "Event Test",
    workspacePath: tempRoot
  });

  await appendEvent(created.paths, {
    projectId: "eventtest",
    eventType: "UNIT_EVENT_A",
    source: "system",
    payload: { n: 1 }
  });
  await appendEvent(created.paths, {
    projectId: "eventtest",
    eventType: "UNIT_EVENT_B",
    source: "system",
    payload: { n: 2 }
  });

  const events = await listEvents(created.paths);
  assert.equal(events.length, 2);
  assert.equal(events[0].eventType, "UNIT_EVENT_A");
  assert.equal(events[1].eventType, "UNIT_EVENT_B");
});

test("taskboard updates on task report", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step1-task-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "tasktest",
    name: "Task Test",
    workspacePath: tempRoot
  });

  const userRoot = await ensureUserRootTask(created.paths, "tasktest", {
    taskId: "user-root-1",
    title: "User Root 1",
    creatorRole: "manager",
    creatorSessionId: "manager-system"
  });

  await createTask(created.paths, "tasktest", {
    taskId: "task-123",
    title: "Implement demo",
    ownerRole: "dev",
    parentTaskId: userRoot.taskId,
    rootTaskId: userRoot.taskId,
    state: "READY"
  });
  await recomputeRunnableStates(created.paths, "tasktest");

  const result = await updateTaskboardFromTaskReport(created.paths, "tasktest", {
    schemaVersion: "1.0",
    reportId: "report-1",
    projectId: "tasktest",
    sessionId: "session-a",
    agentId: "agent-a",
    summary: "task done",
    createdAt: new Date().toISOString(),
    results: [
      {
        taskId: "task-123",
        outcome: "DONE",
        summary: "implemented"
      }
    ],
    correlation: {
      request_id: "req-1",
      task_id: "task-123"
    }
  });

  assert.ok(result);
  assert.ok(result.updatedTaskIds.includes("task-123"));
  const state = await readTaskboard(created.paths, "tasktest");
  const target = state.tasks.find((item) => item.taskId === "task-123");
  assert.ok(target);
  assert.equal(target.state, "DONE");
});
