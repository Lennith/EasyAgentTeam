import type express from "express";
import { randomUUID } from "node:crypto";
import { ensureAgentWorkspaces } from "../../services/agent-workspace-service.js";
import {
  createWorkflowRunForApi,
  deleteWorkflowRunForApi,
  listWorkflowCatalogAgents,
  listWorkflowRunsForApi,
  readWorkflowRunForApi,
  readWorkflowTemplateForApi
} from "../../services/workflow-admin-service.js";
import {
  buildOrchestratorAgentCatalog,
  buildOrchestratorAgentWorkspaceDir
} from "../../services/orchestrator/shared/index.js";
import type { AppRuntimeContext } from "../shared/context.js";
import {
  applyTemplateVariables,
  buildRolePromptMapForRoles,
  parseBoolean,
  parseInteger,
  parseReminderMode,
  parseScheduleExpression,
  parseWorkflowRunMode,
  readRouteDiscussRounds,
  readRouteTable,
  readStringField,
  readStringMap,
  sendApiError,
  withDerivedWorkflowRunStatus
} from "../shared/http.js";
import { hasOwnField, recordWorkflowPerfSpan, validateRecurringConfig } from "./route-utils.js";

export function registerWorkflowRunRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot, workflowOrchestrator } = context;

  app.get("/api/workflow-runs", async (_req, res, next) => {
    try {
      const items = await listWorkflowRunsForApi(dataRoot);
      res.status(200).json({ items: items.map((item) => withDerivedWorkflowRunStatus(item)), total: items.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/workflow-runs", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const templateId = readStringField(body, ["template_id", "templateId"]);
      if (!templateId) {
        sendApiError(res, 400, "WORKFLOW_RUN_INPUT_INVALID", "template_id is required");
        return;
      }
      const template = await readWorkflowTemplateForApi(dataRoot, templateId);
      if (!template) {
        sendApiError(res, 404, "WORKFLOW_TEMPLATE_NOT_FOUND", `template '${templateId}' not found`);
        return;
      }
      if (
        Object.prototype.hasOwnProperty.call(body, "workspace_binding_mode") ||
        Object.prototype.hasOwnProperty.call(body, "workspaceBindingMode") ||
        Object.prototype.hasOwnProperty.call(body, "project_id") ||
        Object.prototype.hasOwnProperty.call(body, "projectId")
      ) {
        sendApiError(
          res,
          400,
          "WORKFLOW_RUN_INPUT_INVALID",
          "workspace_binding_mode/project_id is retired; use workspace_path only"
        );
        return;
      }
      const workspacePath = readStringField(body, ["workspace_path", "workspacePath"]);
      if (!workspacePath) {
        sendApiError(res, 400, "WORKFLOW_RUN_INPUT_INVALID", "workspace_path is required");
        return;
      }
      const modeRaw = body.mode ?? body.run_mode ?? body.runMode;
      const parsedMode = parseWorkflowRunMode(modeRaw);
      if (modeRaw !== undefined && !parsedMode) {
        sendApiError(res, 400, "WORKFLOW_RUN_INPUT_INVALID", "mode must be none|loop|schedule");
        return;
      }
      const hasLoopEnabled = hasOwnField(body, "loop_enabled", "loopEnabled");
      const hasScheduleEnabled = hasOwnField(body, "schedule_enabled", "scheduleEnabled");
      const hasScheduleExpression = hasOwnField(body, "schedule_expression", "scheduleExpression");
      const loopEnabled = hasLoopEnabled ? parseBoolean(body.loop_enabled ?? body.loopEnabled, false) : undefined;
      const scheduleEnabled = hasScheduleEnabled
        ? parseBoolean(body.schedule_enabled ?? body.scheduleEnabled, false)
        : undefined;
      const scheduleExpression = hasScheduleExpression
        ? parseScheduleExpression(body.schedule_expression ?? body.scheduleExpression)
        : undefined;
      if (hasScheduleExpression && !scheduleExpression) {
        sendApiError(
          res,
          400,
          "WORKFLOW_RUN_INPUT_INVALID",
          "schedule_expression must be a non-empty MM-DD HH:MM string"
        );
        return;
      }
      const mode = parsedMode ?? (scheduleEnabled ? "schedule" : loopEnabled ? "loop" : "none");
      const resolvedLoopEnabled = loopEnabled ?? mode === "loop";
      const resolvedScheduleEnabled = scheduleEnabled ?? mode === "schedule";
      const recurringError = validateRecurringConfig({
        mode,
        loopEnabled: resolvedLoopEnabled,
        scheduleEnabled: resolvedScheduleEnabled,
        scheduleExpression
      });
      if (recurringError) {
        sendApiError(res, 400, "WORKFLOW_RUN_INPUT_INVALID", recurringError);
        return;
      }
      const isScheduleSeed = parseBoolean(
        body.is_schedule_seed ?? body.isScheduleSeed,
        mode === "schedule" && resolvedScheduleEnabled
      );

      const mergedVariables = {
        ...(template.defaultVariables ?? {}),
        ...(readStringMap(body.variables) ?? {})
      };
      const taskOverrides = readStringMap(body.task_overrides ?? body.taskOverrides);
      const tasks = template.tasks.map((task) => {
        const baseTitle = taskOverrides?.[task.taskId] ?? task.title;
        return {
          ...task,
          resolvedTitle: applyTemplateVariables(baseTitle, mergedVariables)
        };
      });

      const runId = readStringField(body, ["run_id", "runId"]) ?? `workflow-run-${randomUUID().slice(0, 12)}`;
      const runName =
        readStringField(body, ["name"], `${template.name}-${runId.slice(-6)}`) ?? `${template.name}-${runId.slice(-6)}`;
      const routeStartedAt = Date.now();
      try {
        const created = await createWorkflowRunForApi(dataRoot, {
          runId,
          templateId: template.templateId,
          name: runName,
          description: readStringField(body, ["description"], template.description),
          workspacePath,
          routeTable: template.routeTable,
          taskAssignRouteTable: template.taskAssignRouteTable,
          routeDiscussRounds: template.routeDiscussRounds,
          variables: mergedVariables,
          taskOverrides,
          tasks,
          mode,
          loopEnabled: resolvedLoopEnabled,
          scheduleEnabled: resolvedScheduleEnabled,
          scheduleExpression: resolvedScheduleEnabled ? scheduleExpression : undefined,
          isScheduleSeed: resolvedScheduleEnabled ? isScheduleSeed : false,
          autoDispatchEnabled: parseBoolean(body.auto_dispatch_enabled ?? body.autoDispatchEnabled, true),
          autoDispatchRemaining: parseInteger(body.auto_dispatch_remaining ?? body.autoDispatchRemaining) ?? 5,
          holdEnabled: parseBoolean(body.hold_enabled ?? body.holdEnabled, false),
          reminderMode: parseReminderMode(body.reminder_mode ?? body.reminderMode) ?? "backoff"
        });
        const agents = await listWorkflowCatalogAgents(dataRoot);
        const agentCatalog = buildOrchestratorAgentCatalog(agents);
        const runRoles = Array.from(
          new Set(created.tasks.map((task) => task.ownerRole.trim()).filter((item) => item.length > 0))
        );
        const rolePromptMap = buildRolePromptMapForRoles(runRoles, agents);
        await ensureAgentWorkspaces(
          {
            schemaVersion: "1.0",
            projectId: `workflow-${created.runId}`,
            name: created.name,
            workspacePath: created.workspacePath,
            agentIds: runRoles,
            createdAt: created.createdAt,
            updatedAt: created.updatedAt
          },
          rolePromptMap,
          runRoles,
          agentCatalog.roleSummaryMap
        );
        const autoStart = parseBoolean(body.auto_start ?? body.autoStart, false);
        if (!autoStart) {
          await recordWorkflowPerfSpan({
            dataRoot,
            runId,
            scope: "route",
            name: "POST /api/workflow-runs",
            elapsedMs: Date.now() - routeStartedAt,
            ok: true,
            details: { autoStart }
          });
          res.status(201).json(created);
          return;
        }
        const runtime = await workflowOrchestrator.startRun(runId);
        const run = await readWorkflowRunForApi(dataRoot, runId);
        await recordWorkflowPerfSpan({
          dataRoot,
          runId,
          scope: "route",
          name: "POST /api/workflow-runs",
          elapsedMs: Date.now() - routeStartedAt,
          ok: true,
          details: { autoStart }
        });
        res.status(201).json({ runtime, run: run ? withDerivedWorkflowRunStatus(run) : null });
      } catch (error) {
        await recordWorkflowPerfSpan({
          dataRoot,
          runId,
          scope: "route",
          name: "POST /api/workflow-runs",
          elapsedMs: Date.now() - routeStartedAt,
          ok: false,
          error
        });
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/workflow-runs/:run_id", async (req, res, next) => {
    try {
      const run = await readWorkflowRunForApi(dataRoot, req.params.run_id);
      if (!run) {
        sendApiError(res, 404, "WORKFLOW_RUN_NOT_FOUND", `run '${req.params.run_id}' not found`);
        return;
      }
      res.status(200).json(withDerivedWorkflowRunStatus(run));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/workflow-runs/:run_id", async (req, res, next) => {
    try {
      const removed = await deleteWorkflowRunForApi(dataRoot, req.params.run_id);
      res.status(200).json(removed);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/workflow-runs/:run_id/start", async (req, res, next) => {
    try {
      const runtime = await workflowOrchestrator.startRun(req.params.run_id);
      const run = await readWorkflowRunForApi(dataRoot, req.params.run_id);
      res.status(200).json({ runtime, run: run ? withDerivedWorkflowRunStatus(run) : null });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/workflow-runs/:run_id/stop", async (req, res, next) => {
    try {
      const runtime = await workflowOrchestrator.stopRun(req.params.run_id);
      const run = await readWorkflowRunForApi(dataRoot, req.params.run_id);
      res.status(200).json({ runtime, run: run ? withDerivedWorkflowRunStatus(run) : null });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/workflow-runs/:run_id/status", async (req, res, next) => {
    try {
      const runtime = await workflowOrchestrator.getRunStatus(req.params.run_id);
      res.status(200).json(runtime);
    } catch (error) {
      next(error);
    }
  });
}
