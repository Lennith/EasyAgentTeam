import type express from "express";
import { buildWorkflowAgentIOTimeline } from "../../services/workflow-agent-io-timeline-service.js";
import type { AppRuntimeContext } from "../shared/context.js";
import { readStringField, sendApiError } from "../shared/http.js";

export function registerWorkflowMessageRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot, workflowOrchestrator } = context;

  app.post("/api/workflow-runs/:run_id/messages/send", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const to = (body.to ?? {}) as Record<string, unknown>;
      const messageType = readStringField(body, ["message_type", "messageType"], "MANAGER_MESSAGE") as
        | "MANAGER_MESSAGE"
        | "TASK_DISCUSS_REQUEST"
        | "TASK_DISCUSS_REPLY"
        | "TASK_DISCUSS_CLOSED";
      const content = readStringField(body, ["content"]);
      const fromAgent = readStringField(body, ["from_agent", "fromAgent"], "manager") ?? "manager";
      const fromSessionId =
        readStringField(body, ["from_session_id", "fromSessionId"]) ??
        (fromAgent === "manager" ? "manager-system" : "agent-session-unknown");
      if (!content) {
        sendApiError(res, 400, "WORKFLOW_MESSAGE_CONTENT_REQUIRED", "content is required");
        return;
      }
      const result = await workflowOrchestrator.sendRunMessage({
        runId: req.params.run_id,
        fromAgent,
        fromSessionId,
        messageType,
        toRole: (readStringField(to, ["agent", "role"]) ?? readStringField(body, ["to_role", "toRole"])) || undefined,
        toSessionId:
          (readStringField(to, ["session_id", "sessionId"]) ??
            readStringField(body, ["to_session_id", "toSessionId"])) ||
          undefined,
        taskId: readStringField(body, ["task_id", "taskId"]),
        content,
        requestId: readStringField(body, ["request_id", "requestId"]),
        parentRequestId: readStringField(body, ["parent_request_id", "parentRequestId"]),
        discuss:
          typeof body.discuss === "object" && body.discuss !== null
            ? {
                threadId: readStringField(body.discuss as Record<string, unknown>, ["thread_id", "threadId"]),
                requestId: readStringField(body.discuss as Record<string, unknown>, ["request_id", "requestId"])
              }
            : undefined
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
