import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import express from "express";
import { createApp } from "../app.js";
import { getProjectRepositoryBundle } from "../data/repository/project/repository-bundle.js";
import { getProjectRuntimeContext } from "../services/project-runtime-api-service.js";
import { ProjectSessionRuntimeService } from "../services/orchestrator/project/project-session-runtime-service.js";
import { registerApiErrorMiddleware } from "../routes/error-middleware.js";
import { registerProjectRecoveryRoutes } from "../routes/project-recovery-routes.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

async function buildProjectRecoveryTestApp(
  dataRoot: string,
  options: {
    dispatchAccepted?: boolean;
  } = {}
) {
  const dispatchCalls: Array<{
    projectId: string;
    options: Record<string, unknown>;
  }> = [];
  const repositories = getProjectRepositoryBundle(dataRoot);
  const sessionRuntimeService = new ProjectSessionRuntimeService({
    dataRoot,
    providerRegistry: {
      cancelSession: () => false,
      isSessionActive: () => false
    } as never,
    repositories,
    sessionRunningTimeoutMs: 60_000,
    clearInFlightDispatchSession: () => {}
  });
  const app = express();
  app.use(express.json());
  registerProjectRecoveryRoutes(app, {
    dataRoot,
    providerRegistry: {} as never,
    workflowOrchestrator: {} as never,
    orchestrator: {
      dismissSession: (
        projectId: string,
        sessionId: string,
        reason: string,
        actor: "dashboard" | "api" = "dashboard"
      ) => sessionRuntimeService.dismissSession(projectId, sessionId, reason, actor),
      repairSessionStatus: (
        projectId: string,
        sessionId: string,
        targetStatus: "idle" | "blocked",
        reason: string,
        actor: "dashboard" | "api" = "dashboard"
      ) => sessionRuntimeService.repairSessionStatus(projectId, sessionId, targetStatus, reason, actor),
      resetRoleReminderOnManualAction: async (
        projectId: string,
        role: string,
        _reason: "session_created" | "session_dismissed" | "session_repaired" | "session_retry_dispatch_requested"
      ) => {
        const { project, paths } = await getProjectRuntimeContext(dataRoot, projectId);
        await repositories.projectRuntime.updateRoleReminderState(paths, project.projectId, role, {
          reminderCount: 0,
          idleSince: undefined,
          nextReminderAt: undefined,
          lastRoleState: "INACTIVE"
        });
      },
      dispatchProject: async (projectId: string, dispatchOptions: Record<string, unknown>) => {
        dispatchCalls.push({ projectId, options: dispatchOptions });
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

test("project recovery endpoints require confirmation before dismissed repair", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-session-dismiss-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;

  try {
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "dismiss-process",
        name: "Dismiss Process",
        workspace_path: tempRoot
      })
    });
    assert.equal(projectRes.status, 201);

    const sessionRes = await fetch(`${baseUrl}/api/projects/dismiss-process/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-a", role: "dev_impl", status: "running" })
    });
    assert.equal([200, 201].includes(sessionRes.status), true);
    const sessionPayload = (await sessionRes.json()) as { session: { sessionId: string } };
    const sessionId = sessionPayload.session.sessionId;

    const deniedRepairRes = await fetch(
      `${baseUrl}/api/projects/dismiss-process/sessions/${encodeURIComponent(sessionId)}/repair`,
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
      disabled_reason: string | null;
    };
    assert.equal(deniedRepairPayload.error_code, "SESSION_RECOVERY_ACTION_NOT_ALLOWED");
    assert.equal(deniedRepairPayload.next_action, "Dismiss the running session before attempting repair.");

    const dismissRes = await fetch(
      `${baseUrl}/api/projects/dismiss-process/sessions/${encodeURIComponent(sessionId)}/dismiss`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "dashboard_manual_dismiss", actor: "dashboard" })
      }
    );
    assert.equal(dismissRes.status, 200);
    const payload = (await dismissRes.json()) as {
      action: string;
      previous_status: string;
      next_status: string;
      provider_cancel: { attempted: boolean; confirmed: boolean; result: string };
      process_termination?: {
        attempted: boolean;
        result: string;
        message: string | null;
      } | null;
      mapping_cleared: boolean;
      warnings: string[];
      session: { status: string };
    };
    assert.equal(payload.action, "dismiss");
    assert.equal(payload.previous_status, "running");
    assert.equal(payload.next_status, "dismissed");
    assert.equal(payload.provider_cancel.result, "not_supported");
    assert.equal(payload.session.status, "dismissed");
    assert.equal(typeof payload.process_termination?.attempted, "boolean");
    assert.equal(typeof payload.process_termination?.result, "string");

    const confirmRequiredRes = await fetch(
      `${baseUrl}/api/projects/dismiss-process/sessions/${encodeURIComponent(sessionId)}/repair`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_status: "idle", reason: "dashboard_manual_repair" })
      }
    );
    assert.equal(confirmRequiredRes.status, 409);
    const confirmRequiredPayload = (await confirmRequiredRes.json()) as {
      error_code: string;
      risk: string | null;
      details: { requires_confirmation?: boolean } | undefined;
    };
    assert.equal(confirmRequiredPayload.error_code, "SESSION_RECOVERY_CONFIRMATION_REQUIRED");
    assert.match(confirmRequiredPayload.risk ?? "", /Manual recovery/);

    const repairRes = await fetch(
      `${baseUrl}/api/projects/dismiss-process/sessions/${encodeURIComponent(sessionId)}/repair`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_status: "idle",
          reason: "dashboard_manual_repair",
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
      warnings: string[];
      session: { status: string };
    };
    assert.equal(repairPayload.action, "repair");
    assert.equal(repairPayload.previous_status, "dismissed");
    assert.equal(repairPayload.next_status, "idle");
    assert.equal(repairPayload.session.status, "idle");
  } finally {
    await server.close();
  }
});

test("project retry-dispatch is allowed only for idle sessions with active recovery context", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-project-retry-"));
  const dataRoot = path.join(tempRoot, "data");
  const { app, repositories, dispatchCalls } = await buildProjectRecoveryTestApp(dataRoot);
  const created = await repositories.projectRuntime.createProject({
    projectId: "project_retry_scope",
    name: "Project Retry Scope",
    workspacePath: tempRoot
  });
  await repositories.taskboard.createTask(created.paths, created.project.projectId, {
    taskId: "project-root",
    taskKind: "PROJECT_ROOT",
    title: "Project Root",
    ownerRole: "manager"
  });
  await repositories.taskboard.createTask(created.paths, created.project.projectId, {
    taskId: "task_retry",
    taskKind: "EXECUTION",
    parentTaskId: "project-root",
    rootTaskId: "project-root",
    title: "Retry task",
    ownerRole: "dev_impl",
    state: "READY"
  });
  await repositories.sessions.addSession(created.paths, created.project.projectId, {
    sessionId: "sess-retry",
    role: "dev_impl",
    status: "idle",
    currentTaskId: "task_retry",
    errorStreak: 1,
    lastFailureAt: "2026-04-20T10:00:00.000Z",
    lastFailureKind: "error",
    lastFailureEventId: "evt-retry",
    lastFailureTaskId: "task_retry"
  });
  await repositories.projectRuntime.setRoleSessionMapping(created.project.projectId, "dev_impl", "sess-retry");
  await repositories.projectRuntime.updateRoleReminderState(created.paths, created.project.projectId, "dev_impl", {
    reminderCount: 3,
    lastRoleState: "IDLE"
  });

  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;

  try {
    const recoveryRes = await fetch(`${baseUrl}/api/projects/project_retry_scope/runtime-recovery`);
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
      }>;
    };
    const retryItem = recoveryPayload.items.find((item) => item.session_id === "sess-retry");
    assert.equal(retryItem?.can_retry_dispatch, true);

    const bareRetryRes = await fetch(
      `${baseUrl}/api/projects/project_retry_scope/sessions/${encodeURIComponent("sess-retry")}/retry-dispatch`,
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
      `${baseUrl}/api/projects/project_retry_scope/sessions/${encodeURIComponent("sess-retry")}/retry-dispatch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "manual_retry",
          actor: "dashboard",
          expected_status: "idle",
          expected_role_mapping: retryItem?.role_session_mapping,
          expected_current_task_id: retryItem?.current_task_id,
          expected_last_failure_at: retryItem?.last_failure_at,
          expected_last_failure_event_id: retryItem?.last_failure_event_id,
          expected_last_failure_dispatch_id: retryItem?.last_failure_dispatch_id,
          expected_last_failure_message_id: retryItem?.last_failure_message_id,
          expected_last_failure_task_id: retryItem?.last_failure_task_id
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
    assert.equal(retryPayload.current_task_id, "task_retry");
    assert.equal(retryPayload.dispatch_scope, "task");
    assert.equal(retryPayload.accepted, true);
    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0]?.projectId, "project_retry_scope");
    assert.equal(dispatchCalls[0]?.options.mode, "manual");
    assert.equal(dispatchCalls[0]?.options.sessionId, "sess-retry");
    assert.equal(dispatchCalls[0]?.options.taskId, "task_retry");
    assert.equal(dispatchCalls[0]?.options.force, false);
    assert.equal(dispatchCalls[0]?.options.onlyIdle, true);
    assert.equal(dispatchCalls[0]?.options.maxDispatches, 1);
    assert.equal(typeof dispatchCalls[0]?.options.recovery_attempt_id, "string");
    assert.equal((dispatchCalls[0]?.options.recovery_attempt_id as string).length > 0, true);

    const reminderState = await repositories.projectRuntime.getRoleReminderState(
      created.paths,
      created.project.projectId,
      "dev_impl"
    );
    assert.equal(reminderState?.reminderCount, 0);

    const events = await repositories.events.listEvents(created.paths);
    const retryRequested = events.find((event) => event.eventType === "SESSION_RETRY_DISPATCH_REQUESTED");
    const retryAccepted = events.find((event) => event.eventType === "SESSION_RETRY_DISPATCH_ACCEPTED");
    assert.equal(Boolean(retryRequested), true);
    assert.equal(Boolean(retryAccepted), true);
    assert.equal(retryRequested?.payload?.dispatch_scope, "task");
    assert.equal(retryAccepted?.payload?.dispatch_scope, "task");
    assert.equal(typeof retryRequested?.payload?.recovery_attempt_id, "string");
    assert.equal(retryRequested?.payload?.recovery_attempt_id, retryAccepted?.payload?.recovery_attempt_id);
    assert.equal(retryRequested?.payload?.recovery_attempt_id, dispatchCalls[0]?.options.recovery_attempt_id);

    await repositories.sessions.touchSession(created.paths, created.project.projectId, "sess-retry", {
      cooldownUntil: "2099-01-01T00:00:00.000Z"
    });
    const deniedRetryRes = await fetch(
      `${baseUrl}/api/projects/project_retry_scope/sessions/${encodeURIComponent("sess-retry")}/retry-dispatch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "retry_during_cooldown",
          actor: "dashboard",
          expected_status: "idle",
          expected_role_mapping: retryItem?.role_session_mapping,
          expected_current_task_id: retryItem?.current_task_id,
          expected_last_failure_at: retryItem?.last_failure_at,
          expected_last_failure_event_id: retryItem?.last_failure_event_id,
          expected_last_failure_dispatch_id: retryItem?.last_failure_dispatch_id,
          expected_last_failure_message_id: retryItem?.last_failure_message_id,
          expected_last_failure_task_id: retryItem?.last_failure_task_id
        })
      }
    );
    assert.equal(deniedRetryRes.status, 409);
    const deniedRetryPayload = (await deniedRetryRes.json()) as {
      error_code: string;
      disabled_reason: string | null;
    };
    assert.equal(deniedRetryPayload.error_code, "SESSION_RETRY_DISPATCH_NOT_ALLOWED");
    assert.match(deniedRetryPayload.disabled_reason ?? "", /Cooldown is still active/);
  } finally {
    await server.close();
  }
});
