import type express from "express";
import { getProjectRepositoryBundle } from "../data/repository/project/repository-bundle.js";
import {
  buildRecoveryActionRejection,
  buildRecoveryConfirmationRequired
} from "../services/runtime-recovery-action-policy.js";
import { RecoveryCommandError, isRecoveryCommandError } from "../services/runtime-recovery-command-error.js";
import { buildRecoveryPolicyContext } from "../services/runtime-recovery-policy-context.js";
import { retryProjectDispatchSession } from "../services/runtime-retry-dispatch-service.js";
import { buildProjectRuntimeRecovery } from "../services/runtime-recovery-service.js";
import { getProjectRuntimeContext, getProjectSessionById } from "../services/project-runtime-api-service.js";
import type { AppRuntimeContext } from "./shared/context.js";
import { readStringField, sanitizeSessionForApi, sendApiError } from "./shared/http.js";
import {
  readRecoveryActor,
  readRecoveryConfirm,
  readRetryDispatchGuards,
  sendRecoveryRejection
} from "./shared/recovery.js";

export function registerProjectRecoveryRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot, orchestrator } = context;

  app.get("/api/projects/:id/runtime-recovery", async (req, res, next) => {
    try {
      const payload = await buildProjectRuntimeRecovery(dataRoot, req.params.id);
      res.status(200).json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects/:id/sessions/:session_id/dismiss", async (req, res, next) => {
    try {
      const body = (req.body as Record<string, unknown>) ?? {};
      const { project } = await getProjectRuntimeContext(dataRoot, req.params.id);
      const token = req.params.session_id;
      const session = await getProjectSessionById(dataRoot, project.projectId, token);
      if (!session) {
        sendApiError(res, 404, "SESSION_NOT_FOUND", `session '${token}' not found`);
        return;
      }
      const { input, policy } = buildRecoveryPolicyContext({
        scope_kind: "project",
        session,
        role_session_map: project.roleSessionMap
      });
      if (!policy.can_dismiss) {
        sendRecoveryRejection(res, 409, buildRecoveryActionRejection(token, "dismiss", input, policy));
        return;
      }
      if (policy.requires_confirmation && !readRecoveryConfirm(body)) {
        sendRecoveryRejection(res, 409, buildRecoveryConfirmationRequired(token, "dismiss", input, policy));
        return;
      }
      const dismissReason = readStringField(body, ["reason"]) ?? "session_dismissed_by_api";
      const actor = readRecoveryActor(body);
      const dismissed = await orchestrator.dismissSession(project.projectId, token, dismissReason, actor);
      await orchestrator.resetRoleReminderOnManualAction(
        project.projectId,
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

  app.post("/api/projects/:id/sessions/:session_id/repair", async (req, res, next) => {
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
      const { project } = await getProjectRuntimeContext(dataRoot, req.params.id);
      const token = req.params.session_id;
      const session = await getProjectSessionById(dataRoot, project.projectId, token);
      if (!session) {
        sendApiError(res, 404, "SESSION_NOT_FOUND", `session '${token}' not found`);
        return;
      }
      const { input, policy } = buildRecoveryPolicyContext({
        scope_kind: "project",
        session,
        role_session_map: project.roleSessionMap
      });
      const action = targetStatus === "idle" ? "repair_to_idle" : "repair_to_blocked";
      const allowed = targetStatus === "idle" ? policy.can_repair_to_idle : policy.can_repair_to_blocked;
      if (!allowed) {
        sendRecoveryRejection(res, 409, buildRecoveryActionRejection(token, action, input, policy));
        return;
      }
      if (policy.requires_confirmation && !readRecoveryConfirm(body)) {
        sendRecoveryRejection(res, 409, buildRecoveryConfirmationRequired(token, action, input, policy));
        return;
      }
      const repairReason = readStringField(body, ["reason"]) ?? "session_repaired_by_api";
      const actor = readRecoveryActor(body);
      const repaired = await orchestrator.repairSessionStatus(
        req.params.id,
        session.sessionId,
        targetStatus,
        repairReason,
        actor
      );
      await orchestrator.resetRoleReminderOnManualAction(project.projectId, repaired.session.role, "session_repaired");
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

  app.post("/api/projects/:id/sessions/:session_id/retry-dispatch", async (req, res, next) => {
    try {
      const body = (req.body as Record<string, unknown>) ?? {};
      const { project } = await getProjectRuntimeContext(dataRoot, req.params.id);
      const token = req.params.session_id;
      const session = await getProjectSessionById(dataRoot, project.projectId, token);
      if (!session) {
        sendApiError(res, 404, "SESSION_NOT_FOUND", `session '${token}' not found`);
        return;
      }
      const retryReason = readStringField(body, ["reason"]) ?? "session_retry_dispatch_requested_by_api";
      const actor = readRecoveryActor(body);
      const payload = await retryProjectDispatchSession(
        {
          scope_kind: "project",
          scope_id: project.projectId,
          session_id: session.sessionId,
          actor,
          reason: retryReason,
          confirm: readRecoveryConfirm(body),
          ...readRetryDispatchGuards(body)
        },
        {
          loadScope: async (projectId) => await getProjectRepositoryBundle(context.dataRoot).resolveScope(projectId),
          runInUnitOfWork: async (scope, operation) =>
            await getProjectRepositoryBundle(context.dataRoot).runInUnitOfWork(scope, operation),
          getScopeContext: (scope) => ({
            scope_id: scope.project.projectId,
            role_session_map: scope.project.roleSessionMap
          }),
          getSession: async (scope, sessionId) =>
            await getProjectRepositoryBundle(context.dataRoot).sessions.getSession(
              scope.paths,
              scope.project.projectId,
              sessionId
            ),
          touchSession: async (scope, sessionId, patch) =>
            await getProjectRepositoryBundle(context.dataRoot).sessions.touchSession(
              scope.paths,
              scope.project.projectId,
              sessionId,
              patch
            ),
          appendEvent: async (scope, eventType, currentSession, payload) =>
            await getProjectRepositoryBundle(context.dataRoot).events.appendEvent(scope.paths, {
              projectId: scope.project.projectId,
              eventType,
              source: actor === "dashboard" ? "dashboard" : "system",
              sessionId: currentSession.sessionId,
              taskId: currentSession.currentTaskId ?? undefined,
              payload
            }),
          dispatch: async (scope, currentSession, dispatchOptions) => {
            const result = await context.orchestrator.dispatchProject(scope.project.projectId, {
              mode: "manual",
              sessionId: currentSession.sessionId,
              taskId: currentSession.currentTaskId,
              force: false,
              onlyIdle: true,
              maxDispatches: 1,
              recovery_attempt_id: dispatchOptions.recovery_attempt_id
            });
            const first = result.results[0];
            return {
              accepted: result.results.some((item) => item.outcome === "dispatched"),
              dispatch_scope: currentSession.currentTaskId ? "task" : "role",
              reason: first?.reason
            };
          },
          resetReminder: async (scope, role) =>
            await context.orchestrator.resetRoleReminderOnManualAction(
              scope.project.projectId,
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
