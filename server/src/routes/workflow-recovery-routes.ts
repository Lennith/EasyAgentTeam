import type express from "express";
import { getWorkflowRepositoryBundle } from "../data/repository/workflow/repository-bundle.js";
import {
  buildRecoveryActionRejection,
  buildRecoveryConfirmationRequired
} from "../services/runtime-recovery-action-policy.js";
import { RecoveryCommandError, isRecoveryCommandError } from "../services/runtime-recovery-command-error.js";
import { buildRecoveryPolicyContext } from "../services/runtime-recovery-policy-context.js";
import { retryWorkflowDispatchSession } from "../services/runtime-retry-dispatch-service.js";
import { buildWorkflowRuntimeRecovery } from "../services/runtime-recovery-service.js";
import type { AppRuntimeContext } from "./shared/context.js";
import { readStringField, sanitizeSessionForApi, sendApiError } from "./shared/http.js";
import {
  readRecoveryActor,
  readRecoveryConfirm,
  readRetryDispatchGuards,
  sendRecoveryRejection
} from "./shared/recovery.js";

export function registerWorkflowRecoveryRoutes(app: express.Application, context: AppRuntimeContext): void {
  const repositories = getWorkflowRepositoryBundle(context.dataRoot);

  app.get("/api/workflow-runs/:run_id/runtime-recovery", async (req, res, next) => {
    try {
      const payload = await buildWorkflowRuntimeRecovery(context.dataRoot, req.params.run_id);
      res.status(200).json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/workflow-runs/:run_id/sessions/:session_id/dismiss", async (req, res, next) => {
    try {
      const body = (req.body as Record<string, unknown>) ?? {};
      const scope = await repositories.resolveScope(req.params.run_id);
      const session = await repositories.sessions.getSession(scope.run.runId, req.params.session_id);
      if (!session) {
        sendApiError(res, 404, "SESSION_NOT_FOUND", `session '${req.params.session_id}' not found`);
        return;
      }
      const { input, policy } = buildRecoveryPolicyContext({
        scope_kind: "workflow",
        session,
        role_session_map: scope.run.roleSessionMap
      });
      if (!policy.can_dismiss) {
        sendRecoveryRejection(res, 409, buildRecoveryActionRejection(session.sessionId, "dismiss", input, policy));
        return;
      }
      if (policy.requires_confirmation && !readRecoveryConfirm(body)) {
        sendRecoveryRejection(res, 409, buildRecoveryConfirmationRequired(session.sessionId, "dismiss", input, policy));
        return;
      }
      const dismissReason = readStringField(body, ["reason"]) ?? "session_dismissed_by_api";
      const actor = readRecoveryActor(body);
      const dismissed = await context.workflowOrchestrator.dismissRunSession(
        scope.run.runId,
        session.sessionId,
        dismissReason,
        actor
      );
      await context.workflowOrchestrator.resetRoleReminderOnManualAction(
        scope.run.runId,
        dismissed.session.role,
        "session_dismissed"
      );
      res.status(200).json({
        ...dismissed,
        session: sanitizeSessionForApi(dismissed.session)
      });
    } catch (error) {
      if (isRecoveryCommandError(error)) {
        sendRecoveryRejection(res, error.status, error.payload);
        return;
      }
      next(error);
    }
  });

  app.post("/api/workflow-runs/:run_id/sessions/:session_id/repair", async (req, res, next) => {
    try {
      const body = (req.body as Record<string, unknown>) ?? {};
      const targetStatus = readStringField(body, ["target_status", "targetStatus"]);
      if (targetStatus !== "idle" && targetStatus !== "blocked") {
        sendApiError(
          res,
          400,
          "SESSION_REPAIR_INVALID_TARGET",
          "target_status must be idle|blocked",
          "Use target_status=idle or target_status=blocked."
        );
        return;
      }
      const scope = await repositories.resolveScope(req.params.run_id);
      const session = await repositories.sessions.getSession(scope.run.runId, req.params.session_id);
      if (!session) {
        sendApiError(res, 404, "SESSION_NOT_FOUND", `session '${req.params.session_id}' not found`);
        return;
      }
      const { input, policy } = buildRecoveryPolicyContext({
        scope_kind: "workflow",
        session,
        role_session_map: scope.run.roleSessionMap
      });
      const action = targetStatus === "idle" ? "repair_to_idle" : "repair_to_blocked";
      const allowed = targetStatus === "idle" ? policy.can_repair_to_idle : policy.can_repair_to_blocked;
      if (!allowed) {
        sendRecoveryRejection(res, 409, buildRecoveryActionRejection(session.sessionId, action, input, policy));
        return;
      }
      if (policy.requires_confirmation && !readRecoveryConfirm(body)) {
        sendRecoveryRejection(res, 409, buildRecoveryConfirmationRequired(session.sessionId, action, input, policy));
        return;
      }
      const repairReason = readStringField(body, ["reason"]) ?? "session_repaired_by_api";
      const actor = readRecoveryActor(body);
      const repaired = await context.workflowOrchestrator.repairRunSessionStatus(
        scope.run.runId,
        session.sessionId,
        targetStatus,
        repairReason,
        actor
      );
      await context.workflowOrchestrator.resetRoleReminderOnManualAction(
        scope.run.runId,
        repaired.session.role,
        "session_repaired"
      );
      res.status(200).json({
        ...repaired,
        session: sanitizeSessionForApi(repaired.session)
      });
    } catch (error) {
      if (isRecoveryCommandError(error)) {
        sendRecoveryRejection(res, error.status, error.payload);
        return;
      }
      next(error);
    }
  });

  app.post("/api/workflow-runs/:run_id/sessions/:session_id/retry-dispatch", async (req, res, next) => {
    try {
      const body = (req.body as Record<string, unknown>) ?? {};
      const scope = await repositories.resolveScope(req.params.run_id);
      const session = await repositories.sessions.getSession(scope.run.runId, req.params.session_id);
      if (!session) {
        sendApiError(res, 404, "SESSION_NOT_FOUND", `session '${req.params.session_id}' not found`);
        return;
      }
      const retryReason = readStringField(body, ["reason"]) ?? "session_retry_dispatch_requested_by_api";
      const actor = readRecoveryActor(body);
      const payload = await retryWorkflowDispatchSession(
        {
          scope_kind: "workflow",
          scope_id: scope.run.runId,
          session_id: session.sessionId,
          actor,
          reason: retryReason,
          confirm: readRecoveryConfirm(body),
          ...readRetryDispatchGuards(body)
        },
        {
          loadScope: async (runId) => await getWorkflowRepositoryBundle(context.dataRoot).resolveScope(runId),
          runInUnitOfWork: async (resolvedScope, operation) =>
            await getWorkflowRepositoryBundle(context.dataRoot).runInUnitOfWork(resolvedScope, operation),
          getScopeContext: (resolvedScope) => ({
            scope_id: resolvedScope.run.runId,
            role_session_map: resolvedScope.run.roleSessionMap
          }),
          getSession: async (resolvedScope, sessionId) =>
            await getWorkflowRepositoryBundle(context.dataRoot).sessions.getSession(resolvedScope.run.runId, sessionId),
          touchSession: async (resolvedScope, sessionId, patch) =>
            await getWorkflowRepositoryBundle(context.dataRoot).sessions.touchSession(
              resolvedScope.run.runId,
              sessionId,
              patch
            ),
          appendEvent: async (resolvedScope, eventType, currentSession, payload) =>
            await getWorkflowRepositoryBundle(context.dataRoot).events.appendEvent(resolvedScope.run.runId, {
              eventType,
              source: actor === "dashboard" ? "dashboard" : "system",
              sessionId: currentSession.sessionId,
              taskId: currentSession.currentTaskId ?? undefined,
              payload
            }),
          dispatch: async (resolvedScope, currentSession, dispatchOptions) => {
            const result = await context.workflowOrchestrator.dispatchRun(resolvedScope.run.runId, {
              role: currentSession.role,
              sessionId: currentSession.sessionId,
              taskId: currentSession.currentTaskId,
              force: false,
              onlyIdle: true,
              maxDispatches: 1,
              source: "manual",
              recovery_attempt_id: dispatchOptions.recovery_attempt_id
            });
            const first = result.results[0];
            return {
              accepted: result.results.some((item) => item.outcome === "dispatched"),
              dispatch_scope: currentSession.currentTaskId ? "task" : "role",
              reason: first?.reason
            };
          },
          resetReminder: async (resolvedScope, role) =>
            await context.workflowOrchestrator.resetRoleReminderOnManualAction(
              resolvedScope.run.runId,
              role,
              "session_retry_dispatch_requested"
            )
        }
      );
      res.status(200).json({
        ...payload,
        session: sanitizeSessionForApi(payload.session)
      });
    } catch (error) {
      if (isRecoveryCommandError(error)) {
        sendRecoveryRejection(res, error.status, error.payload);
        return;
      }
      next(error);
    }
  });
}
