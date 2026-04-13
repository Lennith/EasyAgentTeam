import type express from "express";
import { handleTaskAction, TaskActionError } from "../services/task-action-service.js";
import { queryProjectTaskDetail, queryProjectTaskTree } from "../services/project-task-query-service.js";
import { patchProjectTask } from "../services/project-task-use-cases.js";
import { getProjectRuntimeContext, type ProjectTaskPatchInput } from "../services/project-runtime-api-service.js";
import { logger } from "../utils/logger.js";
import type { AppRuntimeContext } from "./shared/context.js";
import { resolveTaskActionNextAction, retiredEndpoint } from "./shared/http.js";

export function registerProjectTaskRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot } = context;

  app.post("/api/projects/:id/task-actions", async (req, res, next) => {
    const startTime = Date.now();
    const projectId = req.params.id;
    const requestBody = req.body as Record<string, unknown>;
    logger.info(
      `[API] POST /api/projects/${projectId}/task-actions - request received, body=${JSON.stringify(requestBody)}`
    );

    try {
      const { project, paths } = await getProjectRuntimeContext(dataRoot, req.params.id);
      const result = await handleTaskAction(dataRoot, project, paths, requestBody);
      const duration = Date.now() - startTime;
      logger.info(
        `[API] POST /api/projects/${projectId}/task-actions - completed in ${duration}ms, result=${JSON.stringify(result)}`
      );
      res.status(201).json(result);
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(
        `[API] POST /api/projects/${projectId}/task-actions - error after ${duration}ms: ${error}, body=${JSON.stringify(requestBody)}`
      );
      if (error instanceof TaskActionError) {
        const nextAction = error.nextAction ?? resolveTaskActionNextAction(error.code);
        res.status(error.status).json({
          error_code: error.code,
          error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {})
          },
          message: error.message,
          next_action: nextAction
        });
        return;
      }
      next(error);
    }
  });

  app.post("/api/projects/:id/agent-handoff", async (_req, res) => {
    retiredEndpoint(res, "/api/projects/:id/task-actions");
  });

  app.post("/api/projects/:id/reports", async (_req, res) => {
    retiredEndpoint(res, "/api/projects/:id/task-actions");
  });

  app.get("/api/projects/:id/tasks", async (_req, res) => {
    retiredEndpoint(res, "/api/projects/:id/task-tree");
  });

  app.get("/api/projects/:id/task-tree", async (req, res, next) => {
    try {
      const focusTaskId = typeof req.query.focus_task_id === "string" ? req.query.focus_task_id.trim() : undefined;
      const maxDepthRaw =
        typeof req.query.max_descendant_depth === "string" ? Number(req.query.max_descendant_depth) : undefined;
      if (
        req.query.max_descendant_depth !== undefined &&
        (typeof maxDepthRaw !== "number" || !Number.isFinite(maxDepthRaw) || maxDepthRaw < 0)
      ) {
        res.status(400).json({ code: "TASK_TREE_INVALID_QUERY", error: "max_descendant_depth is invalid" });
        return;
      }
      const includeExternalDependencies =
        req.query.include_external_dependencies === undefined
          ? true
          : String(req.query.include_external_dependencies).toLowerCase() !== "false";
      const response = await queryProjectTaskTree({
        dataRoot,
        projectId: req.params.id,
        focusTaskId,
        maxDescendantDepth: maxDepthRaw,
        includeExternalDependencies
      });
      res.status(200).json(response);
    } catch (error) {
      const typed = error as Error & { code?: string };
      if (typed.code === "TASK_NOT_FOUND") {
        res.status(404).json({ code: "TASK_NOT_FOUND", error: typed.message });
        return;
      }
      next(error);
    }
  });

  app.get("/api/projects/:id/tasks/:task_id/detail", async (req, res, next) => {
    try {
      const taskId = req.params.task_id?.trim();
      if (!taskId) {
        res.status(400).json({ code: "TASK_ID_REQUIRED", error: "task_id is required" });
        return;
      }
      const response = await queryProjectTaskDetail({
        dataRoot,
        projectId: req.params.id,
        taskId
      });
      res.status(200).json(response);
    } catch (error) {
      const typed = error as Error & { code?: string };
      if (typed.code === "TASK_NOT_FOUND") {
        res.status(404).json({ code: "TASK_NOT_FOUND", error: typed.message });
        return;
      }
      next(error);
    }
  });

  app.patch("/api/projects/:id/tasks/:task_id", async (req, res, next) => {
    try {
      const { project, paths } = await getProjectRuntimeContext(dataRoot, req.params.id);
      const taskId = req.params.task_id?.trim();
      if (!taskId) {
        res.status(400).json({ code: "TASK_ID_REQUIRED", error: "task_id is required" });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const patch: ProjectTaskPatchInput = {};
      if (Object.prototype.hasOwnProperty.call(body, "title")) {
        patch.title = typeof body.title === "string" ? body.title.trim() || undefined : undefined;
      }
      if (Object.prototype.hasOwnProperty.call(body, "state")) {
        patch.state =
          typeof body.state === "string" ? (body.state as import("../domain/models.js").TaskState) : undefined;
      }
      if (
        Object.prototype.hasOwnProperty.call(body, "owner_role") ||
        Object.prototype.hasOwnProperty.call(body, "ownerRole")
      ) {
        patch.ownerRole =
          typeof (body.owner_role ?? body.ownerRole) === "string"
            ? ((body.owner_role ?? body.ownerRole) as string)
            : undefined;
      }
      if (Object.prototype.hasOwnProperty.call(body, "dependencies")) {
        patch.dependencies = Array.isArray(body.dependencies)
          ? body.dependencies.map((d) => String(d).trim()).filter((d) => d)
          : undefined;
      }
      if (
        Object.prototype.hasOwnProperty.call(body, "write_set") ||
        Object.prototype.hasOwnProperty.call(body, "writeSet")
      ) {
        const ws = body.write_set ?? body.writeSet;
        patch.writeSet = Array.isArray(ws) ? ws.map((w) => String(w).trim()).filter((w) => w) : undefined;
      }
      if (Object.prototype.hasOwnProperty.call(body, "acceptance")) {
        patch.acceptance = Array.isArray(body.acceptance)
          ? body.acceptance.map((a) => String(a).trim()).filter((a) => a)
          : undefined;
      }
      if (Object.prototype.hasOwnProperty.call(body, "artifacts")) {
        patch.artifacts = Array.isArray(body.artifacts)
          ? body.artifacts.map((a) => String(a).trim()).filter((a) => a)
          : undefined;
      }
      if (Object.prototype.hasOwnProperty.call(body, "priority")) {
        const priority = Number(body.priority);
        if (Number.isFinite(priority)) {
          patch.priority = Math.floor(priority);
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, "alert")) {
        patch.alert = typeof body.alert === "string" ? body.alert.trim() || null : null;
      }
      const patched = await patchProjectTask({
        dataRoot,
        projectId: project.projectId,
        taskId,
        patch
      });
      res.status(200).json({ success: true, task: patched.task });
    } catch (error) {
      const typed = error as Error & { code?: string };
      if (typed.code === "TASK_NOT_FOUND") {
        res.status(404).json({ code: "TASK_NOT_FOUND", error: typed.message });
        return;
      }
      next(error);
    }
  });
}
