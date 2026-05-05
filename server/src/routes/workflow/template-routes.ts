import type express from "express";
import { WorkflowTemplatePatchPayloadSchema, WorkflowTemplatePayloadSchema } from "@autodev/agent-library";
import {
  createWorkflowTemplateForApi,
  deleteWorkflowTemplateForApi,
  listWorkflowTemplatesForApi,
  patchWorkflowTemplateForApi,
  readWorkflowTemplateForApi
} from "../../services/workflow-admin-service.js";
import type { AppRuntimeContext } from "../shared/context.js";
import { sendApiError } from "../shared/http.js";

export function registerWorkflowTemplateRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot } = context;

  app.get("/api/workflow-templates", async (_req, res, next) => {
    try {
      const items = await listWorkflowTemplatesForApi(dataRoot);
      res.status(200).json({ items, total: items.length });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/workflow-templates/:template_id", async (req, res, next) => {
    try {
      const template = await readWorkflowTemplateForApi(dataRoot, req.params.template_id);
      if (!template) {
        sendApiError(res, 404, "WORKFLOW_TEMPLATE_NOT_FOUND", `template '${req.params.template_id}' not found`);
        return;
      }
      res.status(200).json(template);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/workflow-templates", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const parsed = WorkflowTemplatePayloadSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(
          res,
          400,
          "WORKFLOW_TEMPLATE_INPUT_INVALID",
          "template_id, name, tasks[] are required",
          "Provide at least one task with task_id/title/owner_role."
        );
        return;
      }
      const data = parsed.data;
      const created = await createWorkflowTemplateForApi(dataRoot, {
        templateId: data.templateId,
        name: data.name,
        description: data.description ?? undefined,
        tasks: data.tasks,
        routeTable: data.routeTable,
        taskAssignRouteTable: data.taskAssignRouteTable,
        routeDiscussRounds: data.routeDiscussRounds,
        defaultVariables: data.defaultVariables
      });
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/workflow-templates/:template_id", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const parsed = WorkflowTemplatePatchPayloadSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(
          res,
          400,
          "WORKFLOW_TEMPLATE_INPUT_INVALID",
          "template patch payload is invalid",
          "Provide valid name, tasks, route tables, or default variables."
        );
        return;
      }
      const data = parsed.data;
      const updated = await patchWorkflowTemplateForApi(dataRoot, req.params.template_id, {
        name: data.name,
        description: Object.prototype.hasOwnProperty.call(body, "description") ? (data.description ?? null) : undefined,
        tasks: Object.prototype.hasOwnProperty.call(body, "tasks") ? data.tasks : undefined,
        routeTable: data.routeTable,
        taskAssignRouteTable: data.taskAssignRouteTable,
        routeDiscussRounds: data.routeDiscussRounds,
        defaultVariables:
          Object.prototype.hasOwnProperty.call(body, "default_variables") ||
          Object.prototype.hasOwnProperty.call(body, "defaultVariables")
            ? data.defaultVariables
            : undefined
      });
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/workflow-templates/:template_id", async (req, res, next) => {
    try {
      const removed = await deleteWorkflowTemplateForApi(dataRoot, req.params.template_id);
      res.status(200).json(removed);
    } catch (error) {
      next(error);
    }
  });
}
