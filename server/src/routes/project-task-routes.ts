import type express from "express";
import { ProjectTaskActionRequestSchema, ProjectTaskPatchRequestSchema } from "@autodev/agent-library";
import { handleTaskAction, TaskActionError } from "../services/task-action-service.js";
import { queryProjectTaskDetail, queryProjectTaskTree } from "../services/project-task-query-service.js";
import { patchProjectTask } from "../services/project-task-use-cases.js";
import { getProjectRuntimeContext, type ProjectTaskPatchInput } from "../services/project-runtime-api-service.js";
import { logger } from "../utils/logger.js";
import type { AppRuntimeContext } from "./shared/context.js";
import { resolveTaskActionNextAction } from "./shared/http.js";

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
      const parsed = ProjectTaskActionRequestSchema.safeParse(requestBody);
      if (!parsed.success) {
        throw new TaskActionError("task action payload is invalid", "TASK_ACTION_INVALID", 400);
      }
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
      const parsed = ProjectTaskPatchRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ code: "TASK_PATCH_INVALID", error: "task patch payload is invalid" });
        return;
      }
      const patch: ProjectTaskPatchInput = {
        title: parsed.data.title,
        state: parsed.data.state as import("../domain/models.js").TaskState | undefined,
        ownerRole: parsed.data.ownerRole,
        dependencies: parsed.data.dependencies,
        writeSet: parsed.data.writeSet,
        acceptance: parsed.data.acceptance,
        artifacts: parsed.data.artifacts,
        priority: parsed.data.priority,
        alert: parsed.data.alert
      };
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
