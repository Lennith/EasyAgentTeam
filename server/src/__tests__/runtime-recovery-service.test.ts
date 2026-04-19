import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { getProjectRepositoryBundle } from "../data/repository/project/repository-bundle.js";
import { appendEvent } from "../data/repository/project/event-repository.js";
import { readTaskboard } from "../data/repository/project/taskboard-repository.js";
import { createWorkflowRun, createWorkflowTemplate } from "../data/repository/workflow/run-repository.js";
import {
  appendWorkflowRunEvent,
  readWorkflowRunTaskRuntimeState,
  touchWorkflowSession,
  upsertWorkflowSession,
  writeWorkflowRunTaskRuntimeState
} from "../data/repository/workflow/runtime-repository.js";
import { buildProjectRuntimeRecovery, buildWorkflowRuntimeRecovery } from "../services/runtime-recovery-service.js";

const LEGACY_DONE_STATE = ["MAY", "BE", "DONE"].join("_");

test("project runtime recovery aggregates latest runner failure and current task context", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-project-recovery-"));
  const repositories = getProjectRepositoryBundle(dataRoot);
  const created = await repositories.projectRuntime.createProject({
    projectId: "project_recovery_scope",
    name: "Project Recovery Scope",
    workspacePath: path.join(dataRoot, "workspace"),
    autoDispatchEnabled: true,
    autoDispatchRemaining: 3,
    holdEnabled: false,
    reminderMode: "backoff"
  });

  await repositories.taskboard.createTask(created.paths, created.project.projectId, {
    taskId: "project-root",
    taskKind: "PROJECT_ROOT",
    title: "Project Root",
    ownerRole: "manager"
  });
  await repositories.taskboard.createTask(created.paths, created.project.projectId, {
    taskId: "task_dev_exec",
    taskKind: "EXECUTION",
    parentTaskId: "project-root",
    rootTaskId: "project-root",
    title: "Implement recovery center",
    ownerRole: "dev",
    state: "READY"
  });
  await repositories.sessions.addSession(created.paths, created.project.projectId, {
    sessionId: "session-dev",
    role: "dev",
    status: "idle",
    currentTaskId: "task_dev_exec",
    provider: "minimax",
    providerSessionId: "provider-session-dev",
    cooldownUntil: "2099-01-01T00:00:00.000Z",
    errorStreak: 2,
    timeoutStreak: 1,
    lastFailureAt: "2026-04-19T10:00:00.000Z",
    lastFailureKind: "error"
  });
  await appendEvent(created.paths, {
    projectId: created.project.projectId,
    eventType: "RUNNER_TRANSIENT_ERROR_SOFT",
    source: "system",
    sessionId: "session-dev",
    taskId: "task_dev_exec",
    payload: {
      retryable: true,
      code: "PROVIDER_UPSTREAM_TRANSIENT_ERROR",
      message: "upstream temporarily overloaded",
      next_action: "Wait for cooldown and retry the same task/message dispatch.",
      raw_status: 529
    }
  });

  const payload = await buildProjectRuntimeRecovery(dataRoot, created.project.projectId);
  assert.equal(payload.scope_kind, "project");
  assert.equal(payload.scope_id, created.project.projectId);
  assert.equal(payload.summary.total, 1);
  assert.equal(payload.summary.cooling_down, 1);
  assert.equal(payload.summary.failed_recently, 1);

  const item = payload.items[0];
  assert.equal(item.role, "dev");
  assert.equal(item.session_id, "session-dev");
  assert.equal(item.provider, "minimax");
  assert.equal(item.provider_session_id, "provider-session-dev");
  assert.equal(item.current_task_id, "task_dev_exec");
  assert.equal(item.current_task_title, "Implement recovery center");
  assert.equal(item.current_task_state, "READY");
  assert.equal(item.retryable, true);
  assert.equal(item.code, "PROVIDER_UPSTREAM_TRANSIENT_ERROR");
  assert.equal(item.next_action, "Wait for cooldown and retry the same task/message dispatch.");
  assert.equal(item.raw_status, 529);
  assert.equal(item.last_event_type, "RUNNER_TRANSIENT_ERROR_SOFT");
  assert.equal(item.can_dismiss, true);
  assert.equal(item.can_repair_to_idle, false);
  assert.equal(item.can_repair_to_blocked, true);
});

test("workflow runtime recovery aggregates session status, task snapshot, and latest failure", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-recovery-"));
  await createWorkflowTemplate(dataRoot, {
    templateId: "workflow_recovery_tpl",
    name: "Workflow Recovery Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowRun(dataRoot, {
    runId: "workflow_recovery_run",
    templateId: "workflow_recovery_tpl",
    name: "Workflow Recovery Run",
    workspacePath: path.join(dataRoot, "workspace"),
    tasks: [{ taskId: "task_a", title: "Task A", resolvedTitle: "Task A", ownerRole: "lead" }]
  });
  await writeWorkflowRunTaskRuntimeState(dataRoot, "workflow_recovery_run", {
    initializedAt: "2026-04-19T09:59:00.000Z",
    updatedAt: "2026-04-19T10:00:00.000Z",
    transitionSeq: 1,
    tasks: [
      {
        taskId: "task_a",
        state: "READY",
        blockedBy: [],
        blockedReasons: [],
        lastTransitionAt: "2026-04-19T10:00:00.000Z",
        transitionCount: 1,
        transitions: [{ seq: 1, at: "2026-04-19T10:00:00.000Z", fromState: null, toState: "READY" }]
      }
    ]
  });
  await upsertWorkflowSession(dataRoot, "workflow_recovery_run", {
    sessionId: "session-lead",
    role: "lead",
    status: "blocked",
    provider: "minimax",
    providerSessionId: "provider-session-lead",
    cooldownUntil: "2099-01-01T00:00:00.000Z",
    errorStreak: 1,
    timeoutStreak: 0,
    lastFailureAt: "2026-04-19T10:00:00.000Z",
    lastFailureKind: "error"
  });
  await touchWorkflowSession(dataRoot, "workflow_recovery_run", "session-lead", {
    currentTaskId: "task_a"
  });
  await appendWorkflowRunEvent(dataRoot, "workflow_recovery_run", {
    eventType: "RUNNER_CONFIG_ERROR_BLOCKED",
    source: "system",
    sessionId: "session-lead",
    taskId: "task_a",
    payload: {
      code: "PROVIDER_MODEL_MISMATCH",
      message: "provider and model do not match",
      retryable: false,
      next_action: "Choose a model compatible with the provider before retrying.",
      raw_status: "config"
    }
  });

  const payload = await buildWorkflowRuntimeRecovery(dataRoot, "workflow_recovery_run");
  assert.equal(payload.scope_kind, "workflow");
  assert.equal(payload.scope_id, "workflow_recovery_run");
  assert.equal(payload.summary.total, 1);
  assert.equal(payload.summary.blocked, 1);
  assert.equal(payload.summary.cooling_down, 1);
  assert.equal(payload.summary.failed_recently, 1);

  const item = payload.items[0];
  assert.equal(item.role, "lead");
  assert.equal(item.session_id, "session-lead");
  assert.equal(item.current_task_id, "task_a");
  assert.equal(item.current_task_title, "Task A");
  assert.equal(item.current_task_state, "READY");
  assert.equal(item.code, "PROVIDER_MODEL_MISMATCH");
  assert.equal(item.retryable, false);
  assert.equal(item.next_action, "Choose a model compatible with the provider before retrying.");
  assert.equal(item.raw_status, "config");
  assert.equal(item.last_event_type, "RUNNER_CONFIG_ERROR_BLOCKED");
  assert.equal(item.can_dismiss, true);
  assert.equal(item.can_repair_to_idle, true);
  assert.equal(item.can_repair_to_blocked, false);
});

test("project taskboard migration rewrites legacy ambiguous done state to DONE on read", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-project-legacy-done-"));
  const repositories = getProjectRepositoryBundle(dataRoot);
  const created = await repositories.projectRuntime.createProject({
    projectId: "project_legacy_done",
    name: "Project Legacy Done",
    workspacePath: path.join(dataRoot, "workspace")
  });
  await writeFile(
    created.paths.taskboardFile,
    `${JSON.stringify(
      {
        schemaVersion: "1.0",
        projectId: created.project.projectId,
        updatedAt: "2026-04-19T10:00:00.000Z",
        tasks: [
          {
            taskId: "task_legacy",
            taskKind: "EXECUTION",
            parentTaskId: "task_legacy",
            rootTaskId: "task_legacy",
            title: "Legacy task",
            ownerRole: "lead",
            state: LEGACY_DONE_STATE,
            writeSet: [],
            dependencies: [],
            acceptance: [],
            artifacts: [],
            createdAt: "2026-04-19T10:00:00.000Z",
            updatedAt: "2026-04-19T10:00:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`
  );

  const taskboard = await readTaskboard(created.paths, created.project.projectId);
  assert.equal(taskboard.tasks[0]?.state, "DONE");

  const persisted = JSON.parse(await readFile(created.paths.taskboardFile, "utf8")) as {
    tasks: Array<{ state: string }>;
  };
  assert.equal(persisted.tasks[0]?.state, "DONE");
});

test("workflow runtime migration rewrites legacy ambiguous done state and transitions to DONE on read", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-legacy-done-"));
  await createWorkflowTemplate(dataRoot, {
    templateId: "workflow_legacy_tpl",
    name: "Workflow Legacy Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowRun(dataRoot, {
    runId: "workflow_legacy_run",
    templateId: "workflow_legacy_tpl",
    name: "Workflow Legacy Run",
    workspacePath: path.join(dataRoot, "workspace"),
    tasks: [{ taskId: "task_a", title: "Task A", resolvedTitle: "Task A", ownerRole: "lead" }]
  });
  const tasksFile = path.join(dataRoot, "workflows", "runs", "workflow_legacy_run", "tasks.json");
  await writeFile(
    tasksFile,
    `${JSON.stringify(
      {
        initializedAt: "2026-04-19T10:00:00.000Z",
        updatedAt: "2026-04-19T10:00:00.000Z",
        transitionSeq: 1,
        tasks: [
          {
            taskId: "task_a",
            state: LEGACY_DONE_STATE,
            blockedBy: [],
            blockedReasons: [],
            lastTransitionAt: "2026-04-19T10:00:00.000Z",
            transitionCount: 1,
            transitions: [
              {
                seq: 1,
                at: "2026-04-19T10:00:00.000Z",
                fromState: LEGACY_DONE_STATE,
                toState: LEGACY_DONE_STATE
              }
            ]
          }
        ]
      },
      null,
      2
    )}\n`
  );

  const runtime = await readWorkflowRunTaskRuntimeState(dataRoot, "workflow_legacy_run");
  assert.equal(runtime.tasks[0]?.state, "DONE");
  assert.equal(runtime.tasks[0]?.transitions?.[0]?.fromState, "DONE");
  assert.equal(runtime.tasks[0]?.transitions?.[0]?.toState, "DONE");

  const persisted = JSON.parse(await readFile(tasksFile, "utf8")) as {
    tasks: Array<{ state: string; transitions: Array<{ fromState: string; toState: string }> }>;
  };
  assert.equal(persisted.tasks[0]?.state, "DONE");
  assert.equal(persisted.tasks[0]?.transitions?.[0]?.fromState, "DONE");
  assert.equal(persisted.tasks[0]?.transitions?.[0]?.toState, "DONE");
});
