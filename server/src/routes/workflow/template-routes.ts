import type express from "express";
import {
  createWorkflowTemplateForApi,
  deleteWorkflowTemplateForApi,
  listWorkflowTemplatesForApi,
  patchWorkflowTemplateForApi,
  readWorkflowTemplateForApi
} from "../../services/workflow-admin-service.js";
import type { AppRuntimeContext } from "../shared/context.js";
import {
  readRouteDiscussRounds,
  readRouteTable,
  readStringField,
  readStringMap,
  readWorkflowTasks,
  sendApiError
} from "../shared/http.js";

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
      const templateId = readStringField(body, ["template_id", "templateId"]);
      const name = readStringField(body, ["name"]);
      const tasks = readWorkflowTasks(body.tasks);
      if (!templateId || !name || !tasks || tasks.length === 0) {
        sendApiError(
          res,
          400,
          "WORKFLOW_TEMPLATE_INPUT_INVALID",
          "template_id, name, tasks[] are required",
          "Provide at least one task with task_id/title/owner_role."
        );
        return;
      }
      const created = await createWorkflowTemplateForApi(dataRoot, {
        templateId,
        name,
        description: readStringField(body, ["description"]),
        tasks,
        routeTable: readRouteTable(body.route_table ?? body.routeTable),
        taskAssignRouteTable: readRouteTable(body.task_assign_route_table ?? body.taskAssignRouteTable),
        routeDiscussRounds: readRouteDiscussRounds(body.route_discuss_rounds ?? body.routeDiscussRounds),
        defaultVariables: readStringMap(body.default_variables ?? body.defaultVariables)
      });
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/workflow-templates/:template_id", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const updated = await patchWorkflowTemplateForApi(dataRoot, req.params.template_id, {
        name: readStringField(body, ["name"]),
        description: Object.prototype.hasOwnProperty.call(body, "description")
          ? ((body.description as string | null | undefined) ?? null)
          : undefined,
        tasks: Object.prototype.hasOwnProperty.call(body, "tasks") ? readWorkflowTasks(body.tasks) : undefined,
        routeTable:
          Object.prototype.hasOwnProperty.call(body, "route_table") ||
          Object.prototype.hasOwnProperty.call(body, "routeTable")
            ? readRouteTable(body.route_table ?? body.routeTable)
            : undefined,
        taskAssignRouteTable:
          Object.prototype.hasOwnProperty.call(body, "task_assign_route_table") ||
          Object.prototype.hasOwnProperty.call(body, "taskAssignRouteTable")
            ? readRouteTable(body.task_assign_route_table ?? body.taskAssignRouteTable)
            : undefined,
        routeDiscussRounds:
          Object.prototype.hasOwnProperty.call(body, "route_discuss_rounds") ||
          Object.prototype.hasOwnProperty.call(body, "routeDiscussRounds")
            ? readRouteDiscussRounds(body.route_discuss_rounds ?? body.routeDiscussRounds)
            : undefined,
        defaultVariables:
          Object.prototype.hasOwnProperty.call(body, "default_variables") ||
          Object.prototype.hasOwnProperty.call(body, "defaultVariables")
            ? readStringMap(body.default_variables ?? body.defaultVariables)
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
