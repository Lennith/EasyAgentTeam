import type express from "express";
import { randomUUID } from "node:crypto";
import { buildWorkflowTaskDetail, buildWorkflowTaskTreeResponse } from "../../services/workflow-task-query-service.js";
import { listWorkflowEventsForApi, readWorkflowRunForApi } from "../../services/workflow-admin-service.js";
import type { AppRuntimeContext } from "../shared/context.js";
import { readWorkflowTaskActionRequest, sendApiError } from "../shared/http.js";
import { withWorkflowRoutePerfTrace } from "./route-utils.js";

export function registerWorkflowTaskRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot, workflowOrchestrator } = context;

  app.get("/api/workflow-runs/:run_id/task-runtime", async (req, res, next) => {
    try {
      const snapshot = await withWorkflowRoutePerfTrace(
        dataRoot,
        req.params.run_id,
        "GET /api/workflow-runs/:run_id/task-runtime",
        async () => await workflowOrchestrator.getRunTaskRuntime(req.params.run_id)
      );
      res.status(200).json(snapshot);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/workflow-runs/:run_id/task-actions", async (req, res, next) => {
    try {
      const parsed = readWorkflowTaskActionRequest(req.body);
      if (!parsed) {
        sendApiError(res, 400, "WORKFLOW_TASK_ACTION_INPUT_INVALID", "action_type with valid payload is required");
        return;
      }
      const result = await workflowOrchestrator.applyTaskActions(req.params.run_id, parsed);
      res.status(200).json({
        ...result,
        requestId: randomUUID()
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/workflow-runs/:run_id/task-tree-runtime", async (req, res, next) => {
    try {
      const payload = await withWorkflowRoutePerfTrace(
        dataRoot,
        req.params.run_id,
        "GET /api/workflow-runs/:run_id/task-tree-runtime",
        async () => await workflowOrchestrator.getRunTaskTreeRuntime(req.params.run_id)
      );
      res.status(200).json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/workflow-runs/:run_id/task-tree", async (req, res, next) => {
    try {
      const run = await readWorkflowRunForApi(dataRoot, req.params.run_id);
      if (!run) {
        sendApiError(res, 404, "WORKFLOW_RUN_NOT_FOUND", `run '${req.params.run_id}' not found`);
        return;
      }
      const runtime = await workflowOrchestrator.getRunTaskRuntime(req.params.run_id);
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
      const payload = buildWorkflowTaskTreeResponse({
        run,
        runtimeTasks: runtime.tasks,
        focusTaskId,
        maxDescendantDepth: maxDepthRaw,
        includeExternalDependencies
      });
      res.status(200).json(payload);
    } catch (error) {
      const typed = error as Error & { code?: string };
      if (typed.code === "TASK_NOT_FOUND") {
        res.status(404).json({ code: "TASK_NOT_FOUND", error: typed.message });
        return;
      }
      next(error);
    }
  });

  app.get("/api/workflow-runs/:run_id/tasks/:task_id/detail", async (req, res, next) => {
    try {
      const taskId = req.params.task_id?.trim();
      if (!taskId) {
        res.status(400).json({ code: "TASK_ID_REQUIRED", error: "task_id is required" });
        return;
      }
      const run = await readWorkflowRunForApi(dataRoot, req.params.run_id);
      if (!run) {
        sendApiError(res, 404, "WORKFLOW_RUN_NOT_FOUND", `run '${req.params.run_id}' not found`);
        return;
      }
      const runtime = await workflowOrchestrator.getRunTaskRuntime(req.params.run_id);
      const events = await listWorkflowEventsForApi(dataRoot, req.params.run_id);
      const payload = buildWorkflowTaskDetail({
        run,
        runtimeTasks: runtime.tasks,
        taskId,
        events
      });
      res.status(200).json(payload);
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
