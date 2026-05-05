import type express from "express";
import { WorkflowMessageSendRequestSchema } from "@autodev/agent-library";
import { buildWorkflowAgentIOTimeline } from "../../services/workflow-agent-io-timeline-service.js";
import type { AppRuntimeContext } from "../shared/context.js";
import { sendApiError } from "../shared/http.js";

export function registerWorkflowMessageRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot, workflowOrchestrator } = context;

  app.post("/api/workflow-runs/:run_id/messages/send", async (req, res, next) => {
    try {
      const parsed = WorkflowMessageSendRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendApiError(res, 400, "WORKFLOW_MESSAGE_CONTENT_REQUIRED", "content is required");
        return;
      }
      const body = parsed.data;
      const result = await workflowOrchestrator.sendRunMessage({
        runId: req.params.run_id,
        fromAgent: body.fromAgent,
        fromSessionId: body.fromSessionId,
        messageType: body.messageType,
        toRole: body.toRole,
        toSessionId: body.toSessionId,
        taskId: body.taskId,
        content: body.content,
        requestId: body.requestId,
        parentRequestId: body.parentRequestId,
        discuss: body.discuss
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/workflow-runs/:run_id/agent-io/timeline", async (req, res, next) => {
    try {
      const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? limitRaw : undefined;
      const timeline = await buildWorkflowAgentIOTimeline(dataRoot, req.params.run_id, { limit });
      res.status(200).json(timeline);
    } catch (error) {
      next(error);
    }
  });
}
