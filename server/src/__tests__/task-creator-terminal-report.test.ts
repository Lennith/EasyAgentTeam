import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createProject, ensureProjectRuntime } from "../data/project-store.js";
import { addSession } from "../data/session-store.js";
import { createTask, patchTask } from "../data/taskboard-store.js";
import { listEvents } from "../data/event-store.js";
import { emitCreatorTerminalReportsIfReady } from "../services/task-creator-terminal-report-service.js";

test("creator terminal report dedupe ignores close_report_id changes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-creator-terminal-report-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  const created = await createProject(dataRoot, {
    projectId: "creatorreport",
    name: "Creator Report",
    workspacePath
  });
  const project = created.project;
  const paths = await ensureProjectRuntime(dataRoot, project.projectId);

  await addSession(paths, project.projectId, { sessionId: "sess-creator", role: "dev_manager", status: "idle" });
  await addSession(paths, project.projectId, { sessionId: "sess-dev-a", role: "dev_a", status: "idle" });
  await addSession(paths, project.projectId, { sessionId: "sess-dev-b", role: "dev_b", status: "idle" });

  await createTask(paths, project.projectId, {
    taskId: "project-root-creatorreport",
    taskKind: "PROJECT_ROOT",
    title: "Project Root",
    ownerRole: "manager",
    state: "READY"
  });
  await createTask(paths, project.projectId, {
    taskId: "parent-1",
    taskKind: "USER_ROOT",
    parentTaskId: "project-root-creatorreport",
    title: "Parent",
    ownerRole: "manager",
    state: "IN_PROGRESS"
  });
  await createTask(paths, project.projectId, {
    taskId: "sub-1",
    taskKind: "EXECUTION",
    parentTaskId: "parent-1",
    rootTaskId: "parent-1",
    title: "Sub 1",
    creatorRole: "dev_manager",
    creatorSessionId: "sess-creator",
    ownerRole: "dev_a",
    ownerSession: "sess-dev-a",
    state: "DONE"
  });
  await createTask(paths, project.projectId, {
    taskId: "sub-2",
    taskKind: "EXECUTION",
    parentTaskId: "parent-1",
    rootTaskId: "parent-1",
    title: "Sub 2",
    creatorRole: "dev_manager",
    creatorSessionId: "sess-creator",
    ownerRole: "dev_b",
    ownerSession: "sess-dev-b",
    state: "DONE"
  });
  await patchTask(paths, project.projectId, "sub-1", {
    closeReportId: "report-1",
    closedAt: new Date().toISOString()
  });
  await patchTask(paths, project.projectId, "sub-2", {
    closeReportId: "report-1",
    closedAt: new Date().toISOString()
  });

  await emitCreatorTerminalReportsIfReady(dataRoot, project, paths, "req-1");

  await patchTask(paths, project.projectId, "sub-1", {
    closeReportId: "report-2",
    closedAt: new Date().toISOString()
  });
  await emitCreatorTerminalReportsIfReady(dataRoot, project, paths, "req-2");

  const events = await listEvents(paths);
  const sent = events.filter((item) => item.eventType === "TASK_CREATOR_TERMINAL_REPORT_SENT");
  const skipped = events.filter((item) => item.eventType === "TASK_CREATOR_TERMINAL_REPORT_SKIPPED");

  assert.equal(sent.length, 1);
  assert.equal(
    skipped.some((item) => String((item.payload as Record<string, unknown>).reason ?? "") === "duplicate_signature"),
    true
  );
});
