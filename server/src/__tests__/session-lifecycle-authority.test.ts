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
import {
  markRunnerTimeout,
  markRunnerTransientError,
  resolveActiveSessionForRole
} from "../services/session-lifecycle-authority.js";

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
    const softTimeout = events.find((item) => item.eventType === "RUNNER_TIMEOUT_SOFT");
    const escalatedTimeout = events.find((item) => item.eventType === "RUNNER_TIMEOUT_ESCALATED");
    assert.ok(softTimeout);
    assert.ok(escalatedTimeout);
    assert.equal((softTimeout?.payload as Record<string, unknown>).dispatch_id, "dispatch-timeout");
    assert.equal((softTimeout?.payload as Record<string, unknown>).dispatch_kind, "task");
    assert.equal("cooldown_until" in ((softTimeout?.payload as Record<string, unknown>) ?? {}), true);
  } finally {
    if (previousThreshold === undefined) {
      delete process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD;
    } else {
      process.env.SESSION_TIMEOUT_ESCALATION_THRESHOLD = previousThreshold;
    }
  }
});

test("markRunnerTransientError emits snake_case event payload and keeps session idle with cooldown", async () => {
  const previousCooldown = process.env.SESSION_TRANSIENT_ERROR_COOLDOWN_MS;
  process.env.SESSION_TRANSIENT_ERROR_COOLDOWN_MS = "30000";
  try {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-lifecycle-transient-"));
    const dataRoot = path.join(tempRoot, "data");
    const workspacePath = path.join(tempRoot, "workspace");
    const created = await createProject(dataRoot, {
      projectId: "lifecycletransient",
      name: "Lifecycle Transient",
      workspacePath
    });
    const project = created.project;
    const paths = await ensureProjectRuntime(dataRoot, project.projectId);

    await addSession(paths, project.projectId, {
      sessionId: "session-transient",
      role: "dev_impl",
      status: "running",
      currentTaskId: "task-transient"
    });

    const updated = await markRunnerTransientError({
      dataRoot,
      project,
      paths,
      sessionId: "session-transient",
      runId: "run-transient",
      dispatchId: "dispatch-transient",
      taskId: "task-transient",
      provider: "minimax",
      error: "MiniMax upstream returned transient status 529.",
      code: "PROVIDER_UPSTREAM_TRANSIENT_ERROR",
      nextAction: "Wait for cooldown and retry the same task/message dispatch.",
      rawStatus: 529
    });

    assert.equal(updated?.status, "idle");
    assert.equal(updated?.currentTaskId, "task-transient");
    assert.equal(typeof updated?.cooldownUntil, "string");

    const events = await listEvents(paths);
    const transientEvent = events.find((item) => item.eventType === "RUNNER_TRANSIENT_ERROR_SOFT");
    assert.ok(transientEvent);
    assert.deepEqual(transientEvent?.payload, {
      run_id: "run-transient",
      dispatch_id: "dispatch-transient",
      dispatch_kind: "task",
      message_id: null,
      error: "MiniMax upstream returned transient status 529.",
      code: "PROVIDER_UPSTREAM_TRANSIENT_ERROR",
      retryable: true,
      next_action: "Wait for cooldown and retry the same task/message dispatch.",
      raw_status: 529,
      cooldown_until: updated?.cooldownUntil ?? null
    });
  } finally {
    if (previousCooldown === undefined) {
      delete process.env.SESSION_TRANSIENT_ERROR_COOLDOWN_MS;
    } else {
      process.env.SESSION_TRANSIENT_ERROR_COOLDOWN_MS = previousCooldown;
    }
  }
});
