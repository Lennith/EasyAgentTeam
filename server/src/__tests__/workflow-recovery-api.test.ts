import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import express from "express";
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
import { getWorkflowRepositoryBundle } from "../data/repository/workflow/repository-bundle.js";
import { registerApiErrorMiddleware } from "../routes/error-middleware.js";
import { registerWorkflowRecoveryRoutes } from "../routes/workflow-recovery-routes.js";
import { WorkflowSessionRuntimeService } from "../services/orchestrator/workflow/workflow-session-runtime-service.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

async function buildWorkflowRecoveryTestApp(
  dataRoot: string,
  options: {
    cancelConfirmed?: boolean;
    dispatchAccepted?: boolean;
  } = {}
) {
  const dispatchCalls: Array<{
    runId: string;
    options: Record<string, unknown>;
  }> = [];
  const repositories = getWorkflowRepositoryBundle(dataRoot);
  const providerRegistry = {
    cancelSession: () => options.cancelConfirmed ?? false,
    isSessionActive: () => false
  };
  const sessionRuntimeService = new WorkflowSessionRuntimeService({
    dataRoot,
    repositories,
    providerRegistry: providerRegistry as never,
    sessionRunningTimeoutMs: 60_000,
    sessionHeartbeatThrottle: new Map<string, number>(),
    buildRunSessionKey: (runId: string, sessionId: string) => `${runId}:${sessionId}`,
    clearInFlightDispatchSession: () => {}
  });

  const app = express();
  app.use(express.json());
  registerWorkflowRecoveryRoutes(app, {
    dataRoot,
    providerRegistry: providerRegistry as never,
    orchestrator: {} as never,
    workflowOrchestrator: {
      dismissRunSession: (runId: string, sessionId: string, reason: string, actor: "dashboard" | "api" = "dashboard") =>
        sessionRuntimeService.dismissSession(runId, sessionId, reason, actor),
      repairRunSessionStatus: (
        runId: string,
        sessionId: string,
        targetStatus: "idle" | "blocked",
        reason: string,
        actor: "dashboard" | "api" = "dashboard"
      ) => sessionRuntimeService.repairSessionStatus(runId, sessionId, targetStatus, reason, actor),
      resetRoleReminderOnManualAction: async (
        runId: string,
        role: string,
        _reason: "session_created" | "session_dismissed" | "session_repaired" | "session_retry_dispatch_requested"
      ) => {
        await updateWorkflowRoleReminderState(dataRoot, runId, role, {
          reminderCount: 0,
          idleSince: undefined,
          nextReminderAt: undefined,
          lastRoleState: "INACTIVE"
        });
      },
      dispatchRun: async (runId: string, dispatchOptions: Record<string, unknown>) => {
        dispatchCalls.push({ runId, options: dispatchOptions });
        return {
          limitReached: false,
          results: [
            {
              outcome: options.dispatchAccepted === false ? "skipped" : "dispatched",
              reason: options.dispatchAccepted === false ? "Dispatch was not accepted for this session." : undefined
            }
          ]
        };
      }
    } as never
  });
  registerApiErrorMiddleware(app);
  return { app, repositories, dispatchCalls };
}

async function seedWorkflowRecoveryFixture(
  dataRoot: string,
  runId: string,
  status: "running" | "dismissed" | "idle" = "running"
) {
  const workspaceRoot = path.join(dataRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  await createWorkflowTemplate(dataRoot, {
    templateId: `${runId}_tpl`,
    name: "Workflow Recovery Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowRun(dataRoot, {
    runId,
    templateId: `${runId}_tpl`,
    name: "Workflow Recovery Run",
    workspacePath: workspaceRoot,
    tasks: [{ taskId: "task_a", title: "Task A", resolvedTitle: "Task A", ownerRole: "lead" }]
  });
  await patchWorkflowRun(dataRoot, runId, {
    roleSessionMap: { lead: "session-lead" }
  });
  await writeWorkflowRunTaskRuntimeState(dataRoot, runId, {
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
  await upsertWorkflowSession(dataRoot, runId, {
    sessionId: "session-lead",
    role: "lead",
    status,
    provider: "minimax",
    providerSessionId: "provider-session-lead",
    errorStreak: 1,
    timeoutStreak: 0,
    lastFailureAt: "2026-04-19T10:00:00.000Z",
    lastFailureKind: "error",
    cooldownUntil: status === "running" ? "2099-01-01T00:00:00.000Z" : undefined
  });
  const failureEvent = await appendWorkflowRunEvent(dataRoot, runId, {
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
  await touchWorkflowSession(dataRoot, runId, "session-lead", {
    currentTaskId: "task_a",
    lastFailureEventId: failureEvent.eventId,
    lastFailureTaskId: "task_a"
  });
  await updateWorkflowRoleReminderState(dataRoot, runId, "lead", {
    reminderCount: 3,
    lastRoleState: "IDLE"
  });
}

test("workflow dismiss keeps local state untouched when external stop is unconfirmed", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-recovery-api-"));
  const dataRoot = path.join(tempRoot, "data");
  await seedWorkflowRecoveryFixture(dataRoot, "wf_recovery_unconfirmed");
  const { app, repositories } = await buildWorkflowRecoveryTestApp(dataRoot, {
    cancelConfirmed: false
  });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;

  try {
    const recoveryRes = await fetch(`${baseUrl}/api/workflow-runs/wf_recovery_unconfirmed/runtime-recovery`);
    assert.equal(recoveryRes.status, 200);
    const recoveryPayload = (await recoveryRes.json()) as {
      scope_kind: string;
      summary: { all_sessions_total: number; recovery_candidates_total: number };
      items: Array<{
        session_id: string;
        role: string;
        current_task_id: string | null;
        retryable: boolean | null;
        code: string | null;
        next_action: string | null;
        can_dismiss: boolean;
        can_repair_to_idle: boolean;
        disabled_reason: string | null;
      }>;
    };
    assert.equal(recoveryPayload.scope_kind, "workflow");
    assert.equal(recoveryPayload.summary.all_sessions_total, 1);
    assert.equal(recoveryPayload.summary.recovery_candidates_total, 1);
    assert.equal(recoveryPayload.items[0]?.can_dismiss, true);
    assert.equal(recoveryPayload.items[0]?.can_repair_to_idle, false);
    assert.equal(
      recoveryPayload.items[0]?.disabled_reason,
      "Session is still running. Dismiss it before attempting repair."
    );

    const deniedRepairRes = await fetch(
      `${baseUrl}/api/workflow-runs/wf_recovery_unconfirmed/sessions/${encodeURIComponent("session-lead")}/repair`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_status: "idle" })
      }
    );
    assert.equal(deniedRepairRes.status, 409);
    const deniedRepairPayload = (await deniedRepairRes.json()) as {
      error_code: string;
      next_action: string | null;
    };
    assert.equal(deniedRepairPayload.error_code, "SESSION_RECOVERY_ACTION_NOT_ALLOWED");
    assert.equal(deniedRepairPayload.next_action, "Dismiss the running session before attempting repair.");

    const dismissRes = await fetch(
      `${baseUrl}/api/workflow-runs/wf_recovery_unconfirmed/sessions/${encodeURIComponent("session-lead")}/dismiss`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "dashboard_manual_dismiss", actor: "dashboard" })
      }
    );
    assert.equal(dismissRes.status, 409);
    const dismissPayload = (await dismissRes.json()) as {
      error_code: string;
      disabled_reason: string | null;
    };
    assert.equal(dismissPayload.error_code, "SESSION_DISMISS_EXTERNAL_STOP_UNCONFIRMED");
    assert.equal(dismissPayload.disabled_reason, "External execution stop is not confirmed.");

    const session = await getWorkflowSession(dataRoot, "wf_recovery_unconfirmed", "session-lead");
    assert.equal(session?.status, "running");
    const events = await repositories.events.listEvents("wf_recovery_unconfirmed");
    assert.equal(
      events.some((event) => event.eventType === "SESSION_DISMISS_EXTERNAL_RESULT"),
      true
    );
    assert.equal(
      events.some((event) => event.eventType === "SESSION_STATUS_DISMISSED"),
      false
    );
  } finally {
    await server.close();
  }
});

test("workflow repair requires confirmation after dismiss and retry-dispatch writes audit event", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-recovery-confirmed-"));
  const dataRoot = path.join(tempRoot, "data");
  await seedWorkflowRecoveryFixture(dataRoot, "wf_recovery_confirmed");
  await seedWorkflowRecoveryFixture(dataRoot, "wf_retry_dispatch", "idle");
  await patchWorkflowRun(dataRoot, "wf_retry_dispatch", {
    roleSessionMap: {
      lead: "session-lead",
      qa: "session-task-only"
    }
  });
  await upsertWorkflowSession(dataRoot, "wf_retry_dispatch", {
    sessionId: "session-task-only",
    role: "qa",
    status: "idle",
    provider: "minimax",
    providerSessionId: "provider-session-qa",
    errorStreak: 1,
    timeoutStreak: 0,
    lastFailureAt: "2026-04-19T10:05:00.000Z",
    lastFailureKind: "error",
    lastFailureTaskId: "task_a"
  });
  await touchWorkflowSession(dataRoot, "wf_retry_dispatch", "session-task-only", {
    currentTaskId: "task_a"
  });
  const { app, repositories, dispatchCalls } = await buildWorkflowRecoveryTestApp(dataRoot, {
    cancelConfirmed: true,
    dispatchAccepted: true
  });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;

  try {
    const dismissRes = await fetch(
      `${baseUrl}/api/workflow-runs/wf_recovery_confirmed/sessions/${encodeURIComponent("session-lead")}/dismiss`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "dashboard_manual_dismiss", actor: "dashboard" })
      }
    );
    assert.equal(dismissRes.status, 200);
    const dismissPayload = (await dismissRes.json()) as {
      action: string;
      previous_status: string;
      next_status: string;
      provider_cancel: { attempted: boolean; confirmed: boolean; result: string };
      process_termination: null;
      mapping_cleared: boolean;
    };
    assert.equal(dismissPayload.action, "dismiss");
    assert.equal(dismissPayload.previous_status, "running");
    assert.equal(dismissPayload.next_status, "dismissed");
    assert.equal(dismissPayload.provider_cancel.confirmed, true);
    assert.equal(dismissPayload.provider_cancel.result, "cancelled");
    assert.equal(dismissPayload.mapping_cleared, true);

    const confirmRequiredRes = await fetch(
      `${baseUrl}/api/workflow-runs/wf_recovery_confirmed/sessions/${encodeURIComponent("session-lead")}/repair`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_status: "idle", reason: "manual_recovery", actor: "dashboard" })
      }
    );
    assert.equal(confirmRequiredRes.status, 409);
    const confirmRequiredPayload = (await confirmRequiredRes.json()) as {
      error_code: string;
      details: { requires_confirmation?: boolean } | undefined;
    };
    assert.equal(confirmRequiredPayload.error_code, "SESSION_RECOVERY_CONFIRMATION_REQUIRED");
    assert.equal(confirmRequiredPayload.details?.requires_confirmation, true);

    const repairRes = await fetch(
      `${baseUrl}/api/workflow-runs/wf_recovery_confirmed/sessions/${encodeURIComponent("session-lead")}/repair`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_status: "idle",
          reason: "manual_recovery",
          confirm: true,
          actor: "dashboard"
        })
      }
    );
    assert.equal(repairRes.status, 200);
    const repairPayload = (await repairRes.json()) as {
      action: string;
      previous_status: string;
      next_status: string;
      session: { status: string };
    };
    assert.equal(repairPayload.action, "repair");
    assert.equal(repairPayload.previous_status, "dismissed");
    assert.equal(repairPayload.next_status, "idle");
    assert.equal(repairPayload.session.status, "idle");

    const recoveryRes = await fetch(`${baseUrl}/api/workflow-runs/wf_retry_dispatch/runtime-recovery`);
    assert.equal(recoveryRes.status, 200);
    const recoveryPayload = (await recoveryRes.json()) as {
      items: Array<{
        session_id: string;
        role_session_mapping: string;
        current_task_id: string | null;
        last_failure_at: string | null;
        last_failure_event_id: string | null;
        last_failure_dispatch_id: string | null;
        last_failure_message_id: string | null;
        last_failure_task_id: string | null;
        can_retry_dispatch: boolean;
        recovery_attempts: Array<unknown>;
      }>;
    };
    const retryItem = recoveryPayload.items.find((item) => item.session_id === "session-lead");
    const taskOnlyItem = recoveryPayload.items.find((item) => item.session_id === "session-task-only");
    assert.equal(retryItem?.can_retry_dispatch, true);
    assert.equal(Array.isArray(retryItem?.recovery_attempts), true);
    assert.equal(taskOnlyItem?.can_retry_dispatch, false);

    const bareRetryRes = await fetch(
      `${baseUrl}/api/workflow-runs/wf_retry_dispatch/sessions/${encodeURIComponent("session-lead")}/retry-dispatch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "manual_retry", actor: "dashboard" })
      }
    );
    assert.equal(bareRetryRes.status, 409);
    const bareRetryPayload = (await bareRetryRes.json()) as {
      error_code: string;
      next_action: string | null;
      disabled_reason: string | null;
    };
    assert.equal(bareRetryPayload.error_code, "SESSION_RETRY_GUARD_REQUIRED");
    assert.match(bareRetryPayload.next_action ?? "", /Refresh Recovery Center/i);
    assert.match(bareRetryPayload.disabled_reason ?? "", /expected_status/i);

    const retryRes = await fetch(
      `${baseUrl}/api/workflow-runs/wf_retry_dispatch/sessions/${encodeURIComponent("session-lead")}/retry-dispatch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "manual_retry",
          actor: "dashboard",
          expectedStatus: "idle",
          expectedRoleMapping: retryItem?.role_session_mapping,
          expectedCurrentTaskId: retryItem?.current_task_id,
          expectedLastFailureAt: retryItem?.last_failure_at,
          expectedLastFailureEventId: retryItem?.last_failure_event_id,
          expectedLastFailureDispatchId: retryItem?.last_failure_dispatch_id,
          expectedLastFailureMessageId: retryItem?.last_failure_message_id,
          expectedLastFailureTaskId: retryItem?.last_failure_task_id
        })
      }
    );
    assert.equal(retryRes.status, 200);
    const retryPayload = (await retryRes.json()) as {
      action: string;
      current_task_id: string | null;
      dispatch_scope: string;
      accepted: boolean;
    };
    assert.equal(retryPayload.action, "retry_dispatch");
    assert.equal(retryPayload.current_task_id, "task_a");
    assert.equal(retryPayload.dispatch_scope, "task");
    assert.equal(retryPayload.accepted, true);
    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0]?.runId, "wf_retry_dispatch");
    assert.equal(dispatchCalls[0]?.options.role, "lead");
    assert.equal(dispatchCalls[0]?.options.sessionId, "session-lead");
    assert.equal(dispatchCalls[0]?.options.taskId, "task_a");
    assert.equal(dispatchCalls[0]?.options.force, false);
    assert.equal(dispatchCalls[0]?.options.onlyIdle, true);
    assert.equal(dispatchCalls[0]?.options.maxDispatches, 1);
    assert.equal(dispatchCalls[0]?.options.source, "manual");
    assert.equal(typeof dispatchCalls[0]?.options.recovery_attempt_id, "string");
    assert.equal((dispatchCalls[0]?.options.recovery_attempt_id as string).length > 0, true);

    const reminderAfterRetry = await getWorkflowRoleReminderState(dataRoot, "wf_retry_dispatch", "lead");
    assert.equal(reminderAfterRetry?.reminderCount, 0);
    assert.equal(reminderAfterRetry?.lastRoleState, "INACTIVE");

    const events = await repositories.events.listEvents("wf_retry_dispatch");
    const retryRequested = events.find((event) => event.eventType === "SESSION_RETRY_DISPATCH_REQUESTED");
    const retryAccepted = events.find((event) => event.eventType === "SESSION_RETRY_DISPATCH_ACCEPTED");
    assert.equal(Boolean(retryRequested), true);
    assert.equal(Boolean(retryAccepted), true);
    assert.equal(retryRequested?.payload?.dispatch_scope, "task");
    assert.equal(retryAccepted?.payload?.dispatch_scope, "task");
    assert.equal(typeof retryRequested?.payload?.recovery_attempt_id, "string");
    assert.equal(retryRequested?.payload?.recovery_attempt_id, retryAccepted?.payload?.recovery_attempt_id);
    assert.equal(retryRequested?.payload?.recovery_attempt_id, dispatchCalls[0]?.options.recovery_attempt_id);
  } finally {
    await server.close();
  }
});
