import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import {
  createProject,
  ensureProjectRuntime,
  getProject,
  setRoleSessionMapping
} from "../data/repository/project/runtime-repository.js";
import { appendEvent, listEvents } from "../data/repository/project/event-repository.js";
import { addSession, getSession, touchSession } from "../data/repository/project/session-repository.js";
import { markRunnerTimeout, resolveActiveSessionForRole } from "../services/session-lifecycle-authority.js";

test("resolveActiveSessionForRole dismisses conflicted sessions and updates role map", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-lifecycle-conflict-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  const created = await createProject(dataRoot, {
    projectId: "lifecycleconflict",
    name: "Lifecycle Conflict",
    workspacePath
  });
  const project = created.project;
  const paths = await ensureProjectRuntime(dataRoot, project.projectId);

  await addSession(paths, project.projectId, {
    sessionId: "session-dev-a",
    role: "dev_impl",
    status: "idle",
    provider: "codex"
  });
  await addSession(paths, project.projectId, {
    sessionId: "session-dev-b",
    role: "dev_impl",
    status: "running",
    provider: "codex"
  });
  await setRoleSessionMapping(dataRoot, project.projectId, "dev_impl", "session-dev-a");
  const freshProject = await getProject(dataRoot, project.projectId);

  const active = await resolveActiveSessionForRole({
    dataRoot,
    project: freshProject,
    paths,
    role: "dev_impl",
    reason: "test_conflict_resolution"
  });
  assert.ok(active);
  assert.equal(active?.sessionId, "session-dev-b");

  const loser = await getSession(paths, project.projectId, "session-dev-a");
  assert.ok(loser);
  assert.equal(loser?.status, "dismissed");

  const reloadedProject = await getProject(dataRoot, project.projectId);
  assert.equal(reloadedProject.roleSessionMap?.dev_impl, "session-dev-b");

  const events = await listEvents(paths);
  assert.ok(events.find((item) => item.eventType === "ROLE_SESSION_CONFLICT_DETECTED"));
  assert.ok(events.find((item) => item.eventType === "ROLE_SESSION_CONFLICT_RESOLVED"));
  assert.ok(events.find((item) => item.eventType === "DISPATCH_CLOSED_BY_CONFLICT"));
});

test("markRunnerTimeout escalates after threshold and dismisses session", async () => {
  const previousThreshold = process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD;
  process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD = "2";
  try {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-lifecycle-timeout-"));
    const dataRoot = path.join(tempRoot, "data");
    const workspacePath = path.join(tempRoot, "workspace");
    const created = await createProject(dataRoot, {
      projectId: "lifecycletimeout",
      name: "Lifecycle Timeout",
      workspacePath
    });
    const project = created.project;
    const paths = await ensureProjectRuntime(dataRoot, project.projectId);

    await addSession(paths, project.projectId, {
      sessionId: "session-timeout",
      role: "dev_impl",
      status: "running",
      currentTaskId: "task-timeout"
    });
    await appendEvent(paths, {
      projectId: project.projectId,
      eventType: "ORCHESTRATOR_DISPATCH_STARTED",
      source: "manager",
      sessionId: "session-timeout",
      taskId: "task-timeout",
      payload: { dispatchId: "dispatch-timeout" }
    });

    const first = await markRunnerTimeout({
      dataRoot,
      project,
      paths,
      sessionId: "session-timeout",
      runId: "run-timeout",
      dispatchId: "dispatch-timeout",
      taskId: "task-timeout",
      provider: "codex"
    });
    assert.equal(first.escalated, false);
    assert.equal(first.session?.status, "idle");
    assert.equal(first.session?.timeoutStreak, 1);

    await touchSession(paths, project.projectId, "session-timeout", { status: "running" });
    const second = await markRunnerTimeout({
      dataRoot,
      project,
      paths,
      sessionId: "session-timeout",
      runId: "run-timeout-2",
      dispatchId: "dispatch-timeout",
      taskId: "task-timeout",
      provider: "codex"
    });
    assert.equal(second.escalated, true);
    assert.equal(second.session?.status, "dismissed");
    assert.equal(second.session?.timeoutStreak, 2);

    const events = await listEvents(paths);
    assert.ok(events.find((item) => item.eventType === "RUNNER_TIMEOUT_SOFT"));
    assert.ok(events.find((item) => item.eventType === "RUNNER_TIMEOUT_ESCALATED"));
  } finally {
    if (previousThreshold === undefined) {
      delete process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD;
    } else {
      process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD = previousThreshold;
    }
  }
});
