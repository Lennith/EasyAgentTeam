import type express from "express";
import { getProjectRepositoryBundle } from "../data/repository/project/repository-bundle.js";
import {
  buildRecoveryActionRejection,
  buildRecoveryConfirmationRequired,
  type RecoveryRetryDispatchResult
} from "../services/runtime-recovery-action-policy.js";
import { RecoveryCommandError, isRecoveryCommandError } from "../services/runtime-recovery-command-error.js";
import { buildRecoveryPolicyContext } from "../services/runtime-recovery-policy-context.js";
import { buildProjectRuntimeRecovery } from "../services/runtime-recovery-service.js";
import { getProjectRuntimeContext, getProjectSessionById } from "../services/project-runtime-api-service.js";
import type { SessionRecord } from "../domain/models.js";
import type { AppRuntimeContext } from "./shared/context.js";
import { readStringField, sanitizeSessionForApi, sendApiError } from "./shared/http.js";
import { readRecoveryActor, readRecoveryConfirm, sendRecoveryRejection } from "./shared/recovery.js";

function resolveRecoveryAuditSource(actor: "dashboard" | "api"): "dashboard" | "system" {
  return actor === "dashboard" ? "dashboard" : "system";
}

function buildRetryDispatchNotAllowed(
  sessionId: string,
  policyInput: ReturnType<typeof buildRecoveryPolicyContext>["input"],
  policy: ReturnType<typeof buildRecoveryPolicyContext>["policy"],
  reason: string
) {
  return {
    ...buildRecoveryActionRejection(
      sessionId,
      "retry_dispatch",
      policyInput,
      policy,
      "SESSION_RETRY_DISPATCH_NOT_ALLOWED"
    ),
    message: `retry dispatch is not allowed for session '${sessionId}'`,
    next_action: "Wait until the session is idle and the recovery context is still valid, then retry dispatch again.",
    disabled_reason: reason || policy.disabled_reason,
    risk: policy.risk
  } as const;
}

async function executeProjectRetryDispatch(
  context: AppRuntimeContext,
  projectId: string,
  roleSessionMap: Record<string, string> | undefined,
  session: SessionRecord,
  reason: string,
  actor: "dashboard" | "api"
): Promise<RecoveryRetryDispatchResult<Omit<SessionRecord, "providerSessionId">>> {
  const dispatchScope = session.currentTaskId ? "task" : "role";
  const result = await context.orchestrator.dispatchProject(projectId, {
    mode: "manual",
    sessionId: session.sessionId,
    taskId: session.currentTaskId,
    force: Boolean(session.currentTaskId),
    onlyIdle: false,
    maxDispatches: 1
  });
  const accepted = result.results.some((item) => item.outcome === "dispatched");
  if (!accepted) {
    const contextResult = buildRecoveryPolicyContext({
      scope_kind: "project",
      session,
      role_session_map: roleSessionMap
    });
    const first = result.results[0];
    throw new RecoveryCommandError(
      409,
      buildRetryDispatchNotAllowed(
        session.sessionId,
        contextResult.input,
        contextResult.policy,
        first?.reason ?? "Retry dispatch was not accepted by the orchestrator."
      )
    );
  }

  const repositories = getProjectRepositoryBundle(context.dataRoot);
  const scope = await repositories.resolveScope(projectId);
  await repositories.events.appendEvent(scope.paths, {
    projectId,
    eventType: "SESSION_RETRY_DISPATCH_REQUESTED",
    source: resolveRecoveryAuditSource(actor),
    sessionId: session.sessionId,
    taskId: session.currentTaskId,
    payload: {
      reason,
      actor,
      session_id: session.sessionId,
      current_task_id: session.currentTaskId ?? null,
      dispatch_scope: dispatchScope,
      accepted: true
    }
  });
  await context.orchestrator.resetRoleReminderOnManualAction(
    projectId,
    session.role,
    "session_retry_dispatch_requested"
  );
  const updated = await repositories.sessions.getSession(scope.paths, projectId, session.sessionId);
  if (!updated) {
    throw new Error(`session '${session.sessionId}' not found after retry dispatch`);
  }
  return {
    action: "retry_dispatch",
    session: sanitizeSessionForApi(updated),
    current_task_id: updated.currentTaskId ?? null,
    dispatch_scope: dispatchScope,
    accepted: true,
    warnings: []
  };
}

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
      const contextResult = buildRecoveryPolicyContext({
        scope_kind: "project",
        session,
        role_session_map: project.roleSessionMap
      });
      if (!contextResult.policy.can_retry_dispatch) {
        sendRecoveryRejection(
          res,
          409,
          buildRetryDispatchNotAllowed(
            token,
            contextResult.input,
            contextResult.policy,
            contextResult.policy.disabled_reason ?? "Retry dispatch is not allowed for this session."
          )
        );
        return;
      }
      if (contextResult.policy.requires_confirmation && !readRecoveryConfirm(body)) {
        sendRecoveryRejection(
          res,
          409,
          buildRecoveryConfirmationRequired(token, "retry_dispatch", contextResult.input, contextResult.policy)
        );
        return;
      }
      const retryReason = readStringField(body, ["reason"]) ?? "session_retry_dispatch_requested_by_api";
      const actor = readRecoveryActor(body);
      const payload = await executeProjectRetryDispatch(
        context,
        project.projectId,
        project.roleSessionMap,
        session,
        retryReason,
        actor
      );
      res.status(200).json(payload);
    } catch (error) {
      if (isRecoveryCommandError(error)) {
        sendRecoveryRejection(res, error.status, error.payload);
        return;
      }
      next(error);
    }
  });
}
