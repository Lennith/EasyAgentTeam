import type express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureAgentWorkspaces } from "../services/agent-workspace-service.js";
import { buildWorkflowAgentIOTimeline } from "../services/workflow-agent-io-timeline-service.js";
import { buildWorkflowTaskDetail, buildWorkflowTaskTreeResponse } from "../services/workflow-task-query-service.js";
import {
  createWorkflowRunForApi,
  createWorkflowTemplateForApi,
  deleteWorkflowRunForApi,
  deleteWorkflowTemplateForApi,
  listWorkflowCatalogAgents,
  listWorkflowEventsForApi,
  listWorkflowRunsForApi,
  listWorkflowTemplatesForApi,
  patchWorkflowTemplateForApi,
  readWorkflowRunForApi,
  readWorkflowTemplateForApi
} from "../services/workflow-admin-service.js";
import {
  buildOrchestratorAgentCatalog,
  buildOrchestratorAgentWorkspaceDir,
  buildOrchestratorMinimaxSessionDir,
  resolveOrchestratorManagerUrl,
  resolveOrchestratorProviderSessionId
} from "../services/orchestrator/shared/index.js";
import { resolveSessionProviderId } from "../services/provider-runtime.js";
import { createWorkflowToolExecutionAdapter, DefaultToolInjector } from "../services/tool-injector.js";
import { streamAgentChat, resolveAgentPromptBundle, resolveRuntimeSettings } from "../services/agent-chat-service.js";
import type { ProviderId } from "@autodev/agent-library";
import type { AppRuntimeContext } from "./shared/context.js";
import {
  parseScheduleExpression,
  applyTemplateVariables,
  buildRolePromptMapForRoles,
  parseBoolean,
  parseInteger,
  parseReminderMode,
  parseWorkflowRunMode,
  readProviderIdField,
  readRouteDiscussRounds,
  readRouteTable,
  readStringField,
  readStringMap,
  readWorkflowTaskActionRequest,
  readWorkflowTasks,
  retiredEndpoint,
  sanitizeSessionForApi,
  sendApiError,
  withDerivedWorkflowRunStatus
} from "./shared/http.js";
import { parseWorkflowScheduleExpression } from "../services/orchestrator/workflow/workflow-recurring-schedule.js";

function hasOwnField(body: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(body, key));
}

function validateRecurringConfig(input: {
  mode: "none" | "loop" | "schedule";
  loopEnabled: boolean;
  scheduleEnabled: boolean;
  scheduleExpression?: string;
}): string | null {
  if (input.loopEnabled && input.scheduleEnabled) {
    return "loop and schedule cannot be enabled together";
  }
  if (input.mode === "loop" && input.scheduleEnabled) {
    return "mode=loop cannot enable schedule";
  }
  if (input.mode === "schedule" && input.loopEnabled) {
    return "mode=schedule cannot enable loop";
  }
  if (input.mode === "schedule" || input.scheduleEnabled) {
    if (!input.scheduleExpression) {
      return "schedule_expression is required when schedule is enabled";
    }
    if (!parseWorkflowScheduleExpression(input.scheduleExpression)) {
      return "schedule_expression must be in MM-DD HH:MM format with XX support";
    }
  } else if (input.scheduleExpression) {
    return "schedule_expression is only allowed when schedule is enabled";
  }
  return null;
}

export function registerWorkflowRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot, workflowOrchestrator, providerRegistry } = context;
  app.get("/api/workflow-orchestrator/status", async (_req, res, next) => {
    try {
      res.json(await workflowOrchestrator.getStatus());
    } catch (error) {
      next(error);
    }
  });

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
        res.status(201).json(created);
        return;
      }
      const runtime = await workflowOrchestrator.startRun(runId);
      const run = await readWorkflowRunForApi(dataRoot, runId);
      res.status(201).json({ runtime, run: run ? withDerivedWorkflowRunStatus(run) : null });
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

  app.get("/api/workflow-runs/:run_id/step-runtime", async (_req, res) => {
    retiredEndpoint(res, "/api/workflow-runs/:run_id/task-runtime");
  });

  app.post("/api/workflow-runs/:run_id/step-actions", async (_req, res) => {
    retiredEndpoint(res, "/api/workflow-runs/:run_id/task-actions");
  });

  app.get("/api/workflow-runs/:run_id/task-runtime", async (req, res, next) => {
    try {
      const snapshot = await workflowOrchestrator.getRunTaskRuntime(req.params.run_id);
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
      const payload = await workflowOrchestrator.getRunTaskTreeRuntime(req.params.run_id);
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
      const result = await workflowOrchestrator.registerRunSession(req.params.run_id, {
        role,
        sessionId: readStringField(body, ["session_id", "sessionId"]),
        status: readStringField(body, ["status"]),
        providerSessionId: readStringField(body, ["provider_session_id", "providerSessionId"]),
        provider: body.provider_id !== undefined ? readProviderIdField(body, "provider_id", "minimax") : undefined
      });
      res
        .status(result.created ? 201 : 200)
        .json({ session: sanitizeSessionForApi(result.session), created: result.created });
    } catch (error) {
      next(error);
    }
  });

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

  app.get("/api/workflow-runs/:run_id/orchestrator/settings", async (req, res, next) => {
    try {
      const settings = await workflowOrchestrator.getRunOrchestratorSettings(req.params.run_id);
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/workflow-runs/:run_id/orchestrator/settings", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const reminderModeRaw = body.reminder_mode ?? body.reminderMode;
      const parsedReminderMode = parseReminderMode(reminderModeRaw);
      if (reminderModeRaw !== undefined && !parsedReminderMode) {
        res.status(400).json({
          code: "ORCHESTRATOR_SETTINGS_INVALID",
          error: "reminder_mode must be backoff|fixed_interval"
        });
        return;
      }
      const modeRaw = body.mode ?? body.run_mode ?? body.runMode;
      const parsedMode = parseWorkflowRunMode(modeRaw);
      if (modeRaw !== undefined && !parsedMode) {
        res.status(400).json({
          code: "ORCHESTRATOR_SETTINGS_INVALID",
          error: "mode must be none|loop|schedule"
        });
        return;
      }
      const hasLoopEnabled = hasOwnField(body, "loop_enabled", "loopEnabled");
      const hasScheduleEnabled = hasOwnField(body, "schedule_enabled", "scheduleEnabled");
      const hasScheduleExpression = hasOwnField(body, "schedule_expression", "scheduleExpression");
      const hasIsScheduleSeed = hasOwnField(body, "is_schedule_seed", "isScheduleSeed");
      const incomingLoopEnabled = hasLoopEnabled
        ? parseBoolean(body.loop_enabled ?? body.loopEnabled, false)
        : undefined;
      const incomingScheduleEnabled = hasScheduleEnabled
        ? parseBoolean(body.schedule_enabled ?? body.scheduleEnabled, false)
        : undefined;
      let incomingScheduleExpression: string | null | undefined;
      if (hasScheduleExpression) {
        const rawScheduleExpression = body.schedule_expression ?? body.scheduleExpression;
        if (rawScheduleExpression === null) {
          incomingScheduleExpression = null;
        } else {
          const parsedExpression = parseScheduleExpression(rawScheduleExpression);
          if (!parsedExpression) {
            res.status(400).json({
              code: "ORCHESTRATOR_SETTINGS_INVALID",
              error: "schedule_expression must be a non-empty MM-DD HH:MM string"
            });
            return;
          }
          incomingScheduleExpression = parsedExpression;
        }
      }
      const incomingIsScheduleSeed = hasIsScheduleSeed
        ? parseBoolean(body.is_schedule_seed ?? body.isScheduleSeed, false)
        : undefined;
      const currentSettings = await workflowOrchestrator.getRunOrchestratorSettings(req.params.run_id);
      const mergedLoopEnabled =
        incomingLoopEnabled ??
        (parsedMode === "loop" ? true : parsedMode === "schedule" ? false : currentSettings.loop_enabled);
      const mergedScheduleEnabled =
        incomingScheduleEnabled ??
        (parsedMode === "schedule" ? true : parsedMode === "loop" ? false : currentSettings.schedule_enabled);
      const mergedMode = parsedMode ?? (mergedScheduleEnabled ? "schedule" : mergedLoopEnabled ? "loop" : "none");
      const mergedScheduleExpressionRaw =
        incomingScheduleExpression === undefined
          ? currentSettings.schedule_expression
          : (incomingScheduleExpression ?? undefined);
      const mergedScheduleExpression =
        mergedMode === "schedule" || mergedScheduleEnabled ? mergedScheduleExpressionRaw : undefined;
      const scheduleTransitionedToEnabled =
        (mergedMode === "schedule" || mergedScheduleEnabled) &&
        !(currentSettings.mode === "schedule" || currentSettings.schedule_enabled);
      const mergedIsScheduleSeed =
        incomingIsScheduleSeed ?? (scheduleTransitionedToEnabled ? true : currentSettings.is_schedule_seed);
      const recurringError = validateRecurringConfig({
        mode: mergedMode,
        loopEnabled: mergedLoopEnabled,
        scheduleEnabled: mergedScheduleEnabled,
        scheduleExpression: mergedScheduleExpression
      });
      if (recurringError) {
        res.status(400).json({
          code: "ORCHESTRATOR_SETTINGS_INVALID",
          error: recurringError
        });
        return;
      }
      const shouldClearScheduleExpression =
        incomingScheduleExpression === undefined && mergedMode !== "schedule" && !mergedScheduleEnabled;
      const loopEnabledPatch = incomingLoopEnabled ?? (parsedMode ? mergedLoopEnabled : undefined);
      const scheduleEnabledPatch = incomingScheduleEnabled ?? (parsedMode ? mergedScheduleEnabled : undefined);
      const settings = await workflowOrchestrator.patchRunOrchestratorSettings(req.params.run_id, {
        autoDispatchEnabled:
          body.auto_dispatch_enabled === undefined && body.autoDispatchEnabled === undefined
            ? undefined
            : parseBoolean(body.auto_dispatch_enabled ?? body.autoDispatchEnabled, false),
        autoDispatchRemaining: parseInteger(body.auto_dispatch_remaining ?? body.autoDispatchRemaining),
        holdEnabled:
          body.hold_enabled === undefined && body.holdEnabled === undefined
            ? undefined
            : parseBoolean(body.hold_enabled ?? body.holdEnabled, false),
        reminderMode: parsedReminderMode,
        mode: parsedMode ?? (hasLoopEnabled || hasScheduleEnabled ? mergedMode : undefined),
        loopEnabled: loopEnabledPatch,
        scheduleEnabled: scheduleEnabledPatch,
        scheduleExpression: shouldClearScheduleExpression ? null : incomingScheduleExpression,
        isScheduleSeed: mergedIsScheduleSeed
      });
      res.status(200).json(settings);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/workflow-runs/:run_id/orchestrator/dispatch", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const result = await workflowOrchestrator.dispatchRun(req.params.run_id, {
        source: "manual",
        role: readStringField(body, ["role"]),
        taskId: readStringField(body, ["task_id", "taskId"]),
        force: parseBoolean(body.force, false),
        onlyIdle: parseBoolean(body.only_idle ?? body.onlyIdle, false)
      });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/workflow-runs/:run_id/agent-chat", async (req, res, next) => {
    const runId = req.params.run_id;
    const body = req.body as Record<string, unknown>;
    const role = (body.role as string)?.trim();
    const prompt = (body.prompt as string)?.trim();
    const sessionId = (body.sessionId as string)?.trim();
    const providerSessionId = (body.providerSessionId as string)?.trim();

    if (!role) {
      sendApiError(res, 400, "ROLE_REQUIRED", "role is required", "Provide the agent role to chat with.");
      return;
    }
    if (!prompt) {
      sendApiError(res, 400, "PROMPT_REQUIRED", "prompt is required", "Provide the message to send to the agent.");
      return;
    }

    try {
      await streamAgentChat(
        res,
        providerRegistry,
        {
          resolve: async (input) => {
            const run = await readWorkflowRunForApi(dataRoot, runId);
            if (!run) {
              throw new Error(`workflow run '${runId}' not found`);
            }
            const settings = await resolveRuntimeSettings(dataRoot);
            const providerId = resolveSessionProviderId(run, input.role, "minimax");
            const promptBundle = await resolveAgentPromptBundle(dataRoot, input.role);
            const chatSessionId = input.sessionId || `wf-agent-chat-${Date.now()}-${randomUUID().slice(0, 8)}`;
            const agentWorkspaceDir = buildOrchestratorAgentWorkspaceDir(run.workspacePath, input.role);
            const toolInjection = DefaultToolInjector.build(
              createWorkflowToolExecutionAdapter({
                dataRoot,
                run,
                agentRole: input.role,
                sessionId: chatSessionId,
                applyTaskAction: async (request) =>
                  (await workflowOrchestrator.applyTaskActions(runId, request)) as unknown as Record<string, unknown>,
                sendRunMessage: async (request) =>
                  (await workflowOrchestrator.sendRunMessage({ runId, ...request })) as unknown as Record<
                    string,
                    unknown
                  >
              })
            );
            return {
              providerId,
              settings,
              sessionId: chatSessionId,
              providerSessionId: resolveOrchestratorProviderSessionId(chatSessionId, input.providerSessionId),
              workspaceDir: agentWorkspaceDir,
              workspaceRoot: run.workspacePath,
              role: input.role,
              prompt: input.prompt,
              rolePrompt: promptBundle.rolePrompt,
              skillSegments: promptBundle.skillSegments,
              skillIds: promptBundle.skillIds,
              contextKind: "workflow_agent_chat",
              runtimeConstraints: ["Use TASK_CREATE/TASK_DISCUSS_*/TASK_REPORT through TeamTools APIs."],
              sessionDirFallback: buildOrchestratorMinimaxSessionDir(run.workspacePath),
              apiBaseFallback: "https://api.minimax.io/v1",
              modelFallback: "MiniMax-Text-01",
              env: {
                AUTO_DEV_WORKFLOW_RUN_ID: runId,
                AUTO_DEV_SESSION_ID: chatSessionId,
                AUTO_DEV_AGENT_ROLE: input.role,
                AUTO_DEV_WORKFLOW_ROOT: run.workspacePath,
                AUTO_DEV_AGENT_WORKSPACE: agentWorkspaceDir,
                AUTO_DEV_MANAGER_URL: resolveOrchestratorManagerUrl()
              },
              toolInjection
            };
          }
        },
        { role, prompt, sessionId, providerSessionId }
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/workflow-runs/:run_id/agent-chat/:sessionId/interrupt", async (req, res, next) => {
    const sessionId = req.params.sessionId;
    try {
      const body = req.body as Record<string, unknown>;
      const preferredProviderId = readProviderIdField(body, "provider_id", "minimax");
      const providerCandidates: ProviderId[] = Array.from(new Set([preferredProviderId, "minimax", "codex", "trae"]));
      let cancelled = false;
      for (const providerId of providerCandidates) {
        if (providerRegistry.cancelSession(providerId, sessionId)) {
          cancelled = true;
          break;
        }
      }
      res.json({ success: true, cancelled });
    } catch (error) {
      next(error);
    }
  });
}
