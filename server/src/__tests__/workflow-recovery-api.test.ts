import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import {
  createWorkflowRun,
  createWorkflowTemplate,
  patchWorkflowRun
} from "../data/repository/workflow/run-repository.js";
import {
  appendWorkflowRunEvent,
  getWorkflowSession,
  touchWorkflowSession,
  upsertWorkflowSession,
  writeWorkflowRunTaskRuntimeState
} from "../data/repository/workflow/runtime-repository.js";
import {
  getWorkflowRoleReminderState,
  updateWorkflowRoleReminderState
} from "../data/repository/workflow/reminder-repository.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

test("workflow recovery endpoints expose scoped runtime recovery and dismiss/repair parity", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-recovery-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  await createWorkflowTemplate(dataRoot, {
    templateId: "wf_recovery_tpl",
    name: "Workflow Recovery Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowRun(dataRoot, {
    runId: "wf_recovery_run",
    templateId: "wf_recovery_tpl",
    name: "Workflow Recovery Run",
    workspacePath: workspaceRoot,
    tasks: [{ taskId: "task_a", title: "Task A", resolvedTitle: "Task A", ownerRole: "lead" }]
  });
  await patchWorkflowRun(dataRoot, "wf_recovery_run", {
    roleSessionMap: { lead: "session-lead" }
  });
  await writeWorkflowRunTaskRuntimeState(dataRoot, "wf_recovery_run", {
    initializedAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T10:00:00.000Z",
    transitionSeq: 1,
    tasks: [
      {
        taskId: "task_a",
        state: "IN_PROGRESS",
        blockedBy: [],
        blockedReasons: [],
        lastTransitionAt: "2026-04-19T10:00:00.000Z",
        transitionCount: 1,
        transitions: [{ seq: 1, at: "2026-04-19T10:00:00.000Z", fromState: null, toState: "IN_PROGRESS" }]
      }
    ]
  });
  await upsertWorkflowSession(dataRoot, "wf_recovery_run", {
    sessionId: "session-lead",
    role: "lead",
    status: "running",
    provider: "minimax",
    providerSessionId: "provider-session-lead",
    errorStreak: 1,
    timeoutStreak: 0,
    lastFailureAt: "2026-04-19T10:00:00.000Z",
    lastFailureKind: "error",
    cooldownUntil: "2099-01-01T00:00:00.000Z"
  });
  await touchWorkflowSession(dataRoot, "wf_recovery_run", "session-lead", {
    currentTaskId: "task_a"
  });
  await appendWorkflowRunEvent(dataRoot, "wf_recovery_run", {
    eventType: "RUNNER_TRANSIENT_ERROR_SOFT",
    source: "system",
    sessionId: "session-lead",
    taskId: "task_a",
    payload: {
      retryable: true,
      code: "PROVIDER_UPSTREAM_TRANSIENT_ERROR",
      message: "temporary upstream overload",
      next_action: "Wait for cooldown and retry the same task/message dispatch.",
      raw_status: 529
    }
  });
  await updateWorkflowRoleReminderState(dataRoot, "wf_recovery_run", "lead", {
    reminderCount: 3,
    lastRoleState: "IDLE"
  });

  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;

  try {
    const recoveryRes = await fetch(`${baseUrl}/api/workflow-runs/wf_recovery_run/runtime-recovery`);
    assert.equal(recoveryRes.status, 200);
    const recoveryPayload = (await recoveryRes.json()) as {
      scope_kind: string;
      items: Array<{
        session_id: string;
        role: string;
        current_task_id: string | null;
        retryable: boolean | null;
        code: string | null;
        next_action: string | null;
        can_dismiss: boolean;
        can_repair_to_idle: boolean;
      }>;
    };
    assert.equal(recoveryPayload.scope_kind, "workflow");
    assert.equal(recoveryPayload.items.length, 1);
    assert.equal(recoveryPayload.items[0]?.session_id, "session-lead");
    assert.equal(recoveryPayload.items[0]?.role, "lead");
    assert.equal(recoveryPayload.items[0]?.current_task_id, "task_a");
    assert.equal(recoveryPayload.items[0]?.retryable, true);
    assert.equal(recoveryPayload.items[0]?.code, "PROVIDER_UPSTREAM_TRANSIENT_ERROR");
    assert.equal(recoveryPayload.items[0]?.next_action, "Wait for cooldown and retry the same task/message dispatch.");
    assert.equal(recoveryPayload.items[0]?.can_dismiss, true);
    assert.equal(recoveryPayload.items[0]?.can_repair_to_idle, true);

    const dismissRes = await fetch(
      `${baseUrl}/api/workflow-runs/wf_recovery_run/sessions/${encodeURIComponent("session-lead")}/dismiss`,
      { method: "POST" }
    );
    assert.equal(dismissRes.status, 200);
    const dismissPayload = (await dismissRes.json()) as {
      session: { status: string };
      mappingCleared: boolean;
    };
    assert.equal(dismissPayload.session.status, "dismissed");
    assert.equal(dismissPayload.mappingCleared, true);

    const dismissedSession = await getWorkflowSession(dataRoot, "wf_recovery_run", "session-lead");
    assert.equal(dismissedSession?.status, "dismissed");
    assert.equal(dismissedSession?.currentTaskId, undefined);
    const reminderAfterDismiss = await getWorkflowRoleReminderState(dataRoot, "wf_recovery_run", "lead");
    assert.equal(reminderAfterDismiss?.reminderCount, 0);
    assert.equal(reminderAfterDismiss?.lastRoleState, "INACTIVE");

    const repairRes = await fetch(
      `${baseUrl}/api/workflow-runs/wf_recovery_run/sessions/${encodeURIComponent("session-lead")}/repair`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_status: "idle" })
      }
    );
    assert.equal(repairRes.status, 200);
    const repairPayload = (await repairRes.json()) as { status: string };
    assert.equal(repairPayload.status, "idle");

    const repairedSession = await getWorkflowSession(dataRoot, "wf_recovery_run", "session-lead");
    assert.equal(repairedSession?.status, "idle");
    const reminderAfterRepair = await getWorkflowRoleReminderState(dataRoot, "wf_recovery_run", "lead");
    assert.equal(reminderAfterRepair?.reminderCount, 0);
    assert.equal(reminderAfterRepair?.lastRoleState, "INACTIVE");
  } finally {
    await server.close();
  }
});
