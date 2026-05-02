import type express from "express";
import type { AppRuntimeContext } from "../shared/context.js";
import {
  isUnsupportedProviderId,
  readProviderIdField,
  readStringField,
  sanitizeSessionForApi,
  sendApiError
} from "../shared/http.js";
import { withWorkflowRoutePerfTrace } from "./route-utils.js";

export function registerWorkflowSessionRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot, workflowOrchestrator } = context;

  app.get("/api/workflow-runs/:run_id/sessions", async (req, res, next) => {
    try {
      const payload = await workflowOrchestrator.listRunSessions(req.params.run_id);
      res.status(200).json({ run_id: payload.runId, items: payload.items });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/workflow-runs/:run_id/sessions", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const role = readStringField(body, ["role"]);
      if (!role) {
        sendApiError(res, 400, "WORKFLOW_SESSION_INPUT_INVALID", "role is required");
        return;
      }
      if (isUnsupportedProviderId(body.provider_id)) {
        sendApiError(res, 400, "PROVIDER_NOT_SUPPORTED", "provider_id must be codex, minimax, or dpagent");
        return;
      }
      const result = await withWorkflowRoutePerfTrace(
        dataRoot,
        req.params.run_id,
        "POST /api/workflow-runs/:run_id/sessions",
        async () =>
          await workflowOrchestrator.registerRunSession(req.params.run_id, {
            role,
            sessionId: readStringField(body, ["session_id", "sessionId"]),
            status: readStringField(body, ["status"]),
            providerSessionId: readStringField(body, ["provider_session_id", "providerSessionId"]),
            provider: body.provider_id !== undefined ? readProviderIdField(body, "provider_id", "minimax") : undefined
          })
      );
      res
        .status(result.created ? 201 : 200)
        .json({ session: sanitizeSessionForApi(result.session), created: result.created });
    } catch (error) {
      next(error);
    }
  });
}
