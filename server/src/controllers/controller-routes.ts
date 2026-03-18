import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { appendEvent, eventsToNdjson, listEvents } from "../data/event-store.js";
import { logger } from "../utils/logger.js";
import {
  clearRoleSessionMapping,
  createProject,
  deleteProject,
  ensureProjectRuntime,
  getProject,
  getProjectOverview,
  getProjectPaths,
  listProjects,
  setRoleSessionMapping,
  updateProjectOrchestratorSettings,
  updateProjectRouting,
  updateTaskAssignRouting
} from "../data/project-store.js";
import { ProjectStoreError } from "../data/project-store.js";
import {
  createWorkflowRun,
  createWorkflowTemplate,
  deleteWorkflowRun,
  deleteWorkflowTemplate,
  getWorkflowRun,
  getWorkflowTemplate,
  listWorkflowRuns,
  listWorkflowTemplates,
  patchWorkflowRun,
  patchWorkflowTemplate,
  WorkflowStoreError
} from "../data/workflow-store.js";
import {
  acquireLock,
  createProjectLockScope,
  listActiveLocks,
  LockStoreError,
  releaseLock,
  renewLock
} from "../data/lock-store.js";
import { listTasks, TaskboardStoreError } from "../data/taskboard-store.js";
import { listInboxMessages } from "../data/inbox-store.js";
import { getRuntimeSettings, patchRuntimeSettings } from "../data/runtime-settings-store.js";
import { createAgent, deleteAgent, listAgents, patchAgent, AgentStoreError } from "../data/agent-store.js";
import {
  createSkillList,
  deleteSkill,
  deleteSkillList,
  importSkills,
  listSkillLists,
  listSkills,
  patchSkillList,
  resolveImportedSkillPromptSegments,
  resolveSkillIdsForAgent,
  SkillStoreError,
  validateSkillListIds
} from "../data/skill-store.js";
import {
  AgentTemplateStoreError,
  createCustomAgentTemplate,
  deleteCustomAgentTemplate,
  listCustomAgentTemplates,
  patchCustomAgentTemplate
} from "../data/agent-template-store.js";
import { createTeam, deleteTeam, getTeam, listTeams, updateTeam } from "../data/team-store.js";
import { addSession, getSession, listSessions, SessionStoreError, touchSession } from "../data/session-store.js";
import { listWorkflowRunEvents } from "../data/workflow-run-store.js";
import { BASE_PROMPT_TEXT, BASE_PROMPT_VERSION, getBuiltInAgents } from "../services/agent-prompt-service.js";
import { createOrchestratorService } from "../services/orchestrator-service.js";
import { applyProjectTemplate } from "../services/project-template-service.js";
import { buildAgentIOTimeline } from "../services/agent-io-timeline-service.js";
import { ensureProjectAgentScripts, TeamToolsTemplateError } from "../services/project-agent-script-service.js";
import { ensureAgentWorkspaces } from "../services/agent-workspace-service.js";
import { getRuntimePlatformCapabilities } from "../runtime-platform.js";
import { buildProjectRoutingSnapshot } from "../services/project-routing-snapshot-service.js";
import { createModelManagerService } from "../services/model-manager-service.js";
import { validateRoleSessionMapWrite } from "../services/routing-guard-service.js";
import { ManagerRoutingError } from "../services/manager-routing-service.js";
import { handleTaskAction, TaskActionError } from "../services/task-action-service.js";
import { handleManagerMessageSend, ManagerMessageServiceError } from "../services/manager-message-service.js";
import { resolveActiveSessionForRole } from "../services/session-lifecycle-authority.js";
import { buildTaskTreeResponse } from "../services/task-tree-query-service.js";
import { buildTaskDetailResponse } from "../services/task-detail-query-service.js";
import { buildWorkflowAgentIOTimeline } from "../services/workflow-agent-io-timeline-service.js";
import { buildWorkflowTaskDetail, buildWorkflowTaskTreeResponse } from "../services/workflow-task-query-service.js";
import { createWorkflowOrchestratorService, WorkflowRuntimeError } from "../services/workflow-orchestrator-service.js";
import { createProviderRegistry, resolveSessionProviderId } from "../services/provider-runtime.js";
import { createWorkflowToolExecutionAdapter, DefaultToolInjector } from "../services/tool-injector.js";
import type { ProviderId } from "@autodev/agent-library";

import type { AppRuntimeContext } from "./types.js";
import {
  applyTemplateVariables,
  buildRolePromptMapForRoles,
  buildSessionId,
  parseBoolean,
  parseInteger,
  parseReminderMode,
  readAgentModelConfigsField,
  readNullableStringPatch,
  readProviderIdField,
  readRouteDiscussRounds,
  readRouteTable,
  readStringArray,
  readStringField,
  readStringMap,
  readWorkflowTaskActionRequest,
  readWorkflowTasks,
  resolveTaskActionNextAction,
  retiredEndpoint,
  sanitizeSessionForApi,
  sendApiError,
  withDerivedWorkflowRunStatus
} from "./app-helpers.js";

export function registerSystemRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot, orchestrator, workflowOrchestrator } = context;
  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      service: "autodevelopframework-server",
      time: new Date().toISOString()
    });
  });

  app.get("/api/project-templates", (_req, res) => {
    res.json({
      items: [
        { templateId: "none", name: "No Template", description: "Create empty collaboration project" },
        {
          templateId: "web_mvp",
          name: "Web MVP",
          description: "Starter shape for web MVP workflow (PM -> planner -> dev -> qa)"
        },
        {
          templateId: "repo_doc_flow",
          name: "Repo Doc Flow",
          description: "Scaffold PM/planner/devleader/dev documentation workflow in workspace"
        }
      ],
      total: 3
    });
  });
  app.get("/api/prompts/base", (_req, res) => {
    res.json({
      version: BASE_PROMPT_VERSION,
      prompt: BASE_PROMPT_TEXT
    });
  });

  app.get("/api/settings", async (_req, res, next) => {
    try {
      const settings = await getRuntimeSettings(dataRoot);
      const runtime = getRuntimePlatformCapabilities();
      res.status(200).json({
        codexCliCommand: settings.codexCliCommand,
        traeCliCommand: settings.traeCliCommand,
        theme: settings.theme,
        minimaxApiKey: settings.minimaxApiKey,
        minimaxApiBase: settings.minimaxApiBase,
        minimaxModel: settings.minimaxModel,
        minimaxSessionDir: settings.minimaxSessionDir,
        minimaxMcpServers: settings.minimaxMcpServers,
        minimaxMaxSteps: settings.minimaxMaxSteps,
        minimaxTokenLimit: settings.minimaxTokenLimit,
        minimaxMaxOutputTokens: settings.minimaxMaxOutputTokens,
        hostPlatform: runtime.platform,
        hostPlatformLabel: runtime.label,
        supportedShellTypes: runtime.supportedShells,
        defaultShellType: runtime.defaultShell,
        codexCliCommandDefault: runtime.codexCliCommandDefault,
        traeCliCommandDefault: runtime.traeCliCommandDefault,
        macosUntested: runtime.macosUntested,
        updatedAt: settings.updatedAt
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/settings", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const themeRaw = readStringField(body, ["theme"]);
      const theme = themeRaw === "dark" || themeRaw === "vibrant" || themeRaw === "lively" ? themeRaw : undefined;
      const minimaxApiKeyPatch = readNullableStringPatch(body, ["minimax_api_key", "minimaxApiKey"]);
      const minimaxApiBasePatch = readNullableStringPatch(body, ["minimax_api_base", "minimaxApiBase"]);
      const updated = await patchRuntimeSettings(dataRoot, {
        codexCliCommand: readStringField(body, ["codex_cli_command", "codexCliCommand"]),
        traeCliCommand: readStringField(body, ["trae_cli_command", "traeCliCommand"]),
        theme,
        ...(minimaxApiKeyPatch !== undefined ? { minimaxApiKey: minimaxApiKeyPatch } : {}),
        ...(minimaxApiBasePatch !== undefined ? { minimaxApiBase: minimaxApiBasePatch } : {}),
        minimaxModel: readStringField(body, ["minimax_model", "minimaxModel"]),
        minimaxSessionDir: readStringField(body, ["minimax_session_dir", "minimaxSessionDir"]),
        minimaxMcpServers: body.minimax_mcp_servers ?? (body.minimaxMcpServers as any),
        minimaxMaxSteps:
          typeof body.minimax_max_steps === "number"
            ? body.minimax_max_steps
            : typeof body.minimaxMaxSteps === "number"
              ? body.minimaxMaxSteps
              : undefined,
        minimaxTokenLimit:
          typeof body.minimax_token_limit === "number"
            ? body.minimax_token_limit
            : typeof body.minimaxTokenLimit === "number"
              ? body.minimaxTokenLimit
              : undefined,
        minimaxMaxOutputTokens:
          typeof body.minimax_max_output_tokens === "number"
            ? body.minimax_max_output_tokens
            : typeof body.minimaxMaxOutputTokens === "number"
              ? body.minimaxMaxOutputTokens
              : undefined
      });
      const runtime = getRuntimePlatformCapabilities();
      res.status(200).json({
        codexCliCommand: updated.codexCliCommand,
        traeCliCommand: updated.traeCliCommand,
        theme: updated.theme,
        minimaxApiKey: updated.minimaxApiKey,
        minimaxApiBase: updated.minimaxApiBase,
        minimaxModel: updated.minimaxModel,
        minimaxSessionDir: updated.minimaxSessionDir,
        minimaxMcpServers: updated.minimaxMcpServers,
        minimaxMaxSteps: updated.minimaxMaxSteps,
        minimaxTokenLimit: updated.minimaxTokenLimit,
        minimaxMaxOutputTokens: updated.minimaxMaxOutputTokens,
        hostPlatform: runtime.platform,
        hostPlatformLabel: runtime.label,
        supportedShellTypes: runtime.supportedShells,
        defaultShellType: runtime.defaultShell,
        codexCliCommandDefault: runtime.codexCliCommandDefault,
        traeCliCommandDefault: runtime.traeCliCommandDefault,
        macosUntested: runtime.macosUntested,
        updatedAt: updated.updatedAt
      });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/orchestrator/status", async (_req, res, next) => {
    try {
      const status = await orchestrator.getStatus();
      res.json(status);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/models", async (req, res, next) => {
    try {
      const projectId = typeof req.query.project_id === "string" ? req.query.project_id.trim() : "";
      const refresh = typeof req.query.refresh === "string" && req.query.refresh === "true";

      if (!projectId) {
        const runtimeSettings = await getRuntimeSettings(dataRoot);
        const minimaxModel = runtimeSettings.minimaxModel?.trim() || "MiniMax-M2.5-High-speed";
        const defaultModels = [
          { vendor: "codex", model: "gpt-5.3-codex", description: "Codex recommended model" },
          { vendor: "codex", model: "gpt-5", description: "GPT-5 model" },
          { vendor: "trae", model: "trae-1", description: "Trae 1 model" },
          { vendor: "minimax", model: minimaxModel, description: `MiniMax model: ${minimaxModel}` }
        ];
        res.status(200).json({
          models: defaultModels,
          total: defaultModels.length,
          warnings: ["No project_id provided, returning default models"],
          source: "fallback",
          updatedAt: new Date().toISOString()
        });
        return;
      }

      const paths = getProjectPaths(dataRoot, projectId);
      const modelManager = createModelManagerService(paths, dataRoot);
      const result = refresh ? await modelManager.refreshModels() : await modelManager.getAvailableModels();
      res.status(200).json({
        models: result.models,
        total: result.models.length,
        warnings: result.warnings,
        source: result.source,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      next(error);
    }
  });
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
      const items = await listWorkflowTemplates(dataRoot);
      res.status(200).json({ items, total: items.length });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/workflow-templates/:template_id", async (req, res, next) => {
    try {
      const template = await getWorkflowTemplate(dataRoot, req.params.template_id);
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
      const created = await createWorkflowTemplate(dataRoot, {
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
      const updated = await patchWorkflowTemplate(dataRoot, req.params.template_id, {
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
      const removed = await deleteWorkflowTemplate(dataRoot, req.params.template_id);
      res.status(200).json(removed);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/workflow-runs", async (_req, res, next) => {
    try {
      const items = await listWorkflowRuns(dataRoot);
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
      const template = await getWorkflowTemplate(dataRoot, templateId);
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
      const created = await createWorkflowRun(dataRoot, {
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
        autoDispatchEnabled: parseBoolean(body.auto_dispatch_enabled ?? body.autoDispatchEnabled, true),
        autoDispatchRemaining: parseInteger(body.auto_dispatch_remaining ?? body.autoDispatchRemaining) ?? 5,
        holdEnabled: parseBoolean(body.hold_enabled ?? body.holdEnabled, false),
        reminderMode: parseReminderMode(body.reminder_mode ?? body.reminderMode) ?? "backoff"
      });
      const agents = await listAgents(dataRoot);
      const roleSummaryMap = new Map(agents.map((item) => [item.agentId, item.summary ?? ""]));
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
        roleSummaryMap
      );
      const autoStart = parseBoolean(body.auto_start ?? body.autoStart, false);
      if (!autoStart) {
        res.status(201).json(created);
        return;
      }
      const runtime = await workflowOrchestrator.startRun(runId);
      const run = await getWorkflowRun(dataRoot, runId);
      res.status(201).json({ runtime, run: run ? withDerivedWorkflowRunStatus(run) : null });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/workflow-runs/:run_id", async (req, res, next) => {
    try {
      const run = await getWorkflowRun(dataRoot, req.params.run_id);
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
      const removed = await deleteWorkflowRun(dataRoot, req.params.run_id);
      res.status(200).json(removed);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/workflow-runs/:run_id/start", async (req, res, next) => {
    try {
      const runtime = await workflowOrchestrator.startRun(req.params.run_id);
      const run = await getWorkflowRun(dataRoot, req.params.run_id);
      res.status(200).json({ runtime, run: run ? withDerivedWorkflowRunStatus(run) : null });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/workflow-runs/:run_id/stop", async (req, res, next) => {
    try {
      const runtime = await workflowOrchestrator.stopRun(req.params.run_id);
      const run = await getWorkflowRun(dataRoot, req.params.run_id);
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
      const run = await getWorkflowRun(dataRoot, req.params.run_id);
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
      const run = await getWorkflowRun(dataRoot, req.params.run_id);
      if (!run) {
        sendApiError(res, 404, "WORKFLOW_RUN_NOT_FOUND", `run '${req.params.run_id}' not found`);
        return;
      }
      const runtime = await workflowOrchestrator.getRunTaskRuntime(req.params.run_id);
      const events = await listWorkflowRunEvents(dataRoot, req.params.run_id);
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
        reminderMode: parsedReminderMode
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

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    function sendEvent(event: string, data: unknown) {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    try {
      const run = await getWorkflowRun(dataRoot, runId);
      if (!run) {
        sendEvent("error", { message: `workflow run '${runId}' not found` });
        res.end();
        return;
      }
      const settings = await getRuntimeSettings(dataRoot);
      const providerId = resolveSessionProviderId(run, role, "minimax");
      const agents = await listAgents(dataRoot);
      const roleAgent = agents.find((item) => item.agentId === role);
      const rolePrompt = roleAgent?.prompt;
      const skillIds = await resolveSkillIdsForAgent(dataRoot, roleAgent?.skillList);
      const importedSkillPrompt = await resolveImportedSkillPromptSegments(dataRoot, skillIds);

      const chatSessionId = sessionId || `wf-agent-chat-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const agentWorkspaceDir = path.join(run.workspacePath, "Agents", role);
      const toolInjection = DefaultToolInjector.build(
        createWorkflowToolExecutionAdapter({
          dataRoot,
          run,
          agentRole: role,
          sessionId: chatSessionId,
          applyTaskAction: async (request) =>
            (await workflowOrchestrator.applyTaskActions(runId, request)) as unknown as Record<string, unknown>,
          sendRunMessage: async (request) =>
            (await workflowOrchestrator.sendRunMessage({ runId, ...request })) as unknown as Record<string, unknown>
        })
      );
      sendEvent("session", { sessionId: chatSessionId, providerSessionId });
      await providerRegistry.runSessionWithTools(providerId, settings, {
        prompt,
        providerSessionId: providerSessionId || chatSessionId,
        workspaceDir: agentWorkspaceDir,
        workspaceRoot: run.workspacePath,
        role,
        rolePrompt,
        skillSegments: importedSkillPrompt.segments,
        skillIds,
        contextKind: "workflow_agent_chat",
        runtimeConstraints: ["Use TASK_CREATE/TASK_DISCUSS_*/TASK_REPORT through TeamTools APIs."],
        sessionDirFallback: path.join(run.workspacePath, ".minimax", "sessions"),
        apiBaseFallback: "https://api.minimax.io/v1",
        modelFallback: "MiniMax-Text-01",
        teamToolContext: toolInjection.teamToolContext,
        teamToolBridge: toolInjection.teamToolBridge,
        env: {
          AUTO_DEV_WORKFLOW_RUN_ID: runId,
          AUTO_DEV_SESSION_ID: chatSessionId,
          AUTO_DEV_AGENT_ROLE: role,
          AUTO_DEV_WORKFLOW_ROOT: run.workspacePath,
          AUTO_DEV_AGENT_WORKSPACE: agentWorkspaceDir,
          AUTO_DEV_MANAGER_URL: process.env.AUTO_DEV_MANAGER_URL ?? "http://127.0.0.1:43123"
        },
        callback: {
          onThinking: (thinking: string) => sendEvent("thinking", { thinking }),
          onToolCall: (name: string, args: Record<string, unknown>) => sendEvent("tool_call", { name, args }),
          onToolResult: (name: string, result: { success: boolean; content: string; error?: string }) =>
            sendEvent("tool_result", { name, result }),
          onStep: (step: number, maxSteps: number) => sendEvent("step", { step, maxSteps }),
          onMessage: (agentRole: string, content: string) => sendEvent("message", { role: agentRole, content }),
          onError: (error: Error) => sendEvent("error", { message: error.message }),
          onComplete: (result: string, finishReason?: string, meta?) =>
            sendEvent("complete", {
              result,
              finishReason,
              usage: meta?.usage,
              recoveredFromMaxTokens: meta?.recoveredFromMaxTokens ?? false
            })
        }
      });

      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      sendEvent("error", { message });
      res.end();
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

  // ========================================
  // Agent Chat API - Direct agent communication (SSE Streaming)
  // ========================================
}

export function registerAgentTeamSkillRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot } = context;
  app.get("/api/agents", async (_req, res, next) => {
    try {
      const custom = await listAgents(dataRoot);
      res.status(200).json({
        items: custom.map((item) => {
          const { defaultCliTool, skillList, ...rest } = item;
          return {
            ...rest,
            provider_id: defaultCliTool,
            skill_list: skillList ?? []
          };
        }),
        total: custom.length
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agent-templates", async (_req, res, next) => {
    try {
      const builtInItems = getBuiltInAgents().map((item) => ({
        templateId: item.agentId,
        displayName: item.displayName,
        prompt: item.prompt,
        source: "built-in" as const
      }));
      const customItems = (await listCustomAgentTemplates(dataRoot)).map((item) => ({
        ...item,
        source: "custom" as const
      }));
      res.status(200).json({ builtInItems, customItems, total: builtInItems.length + customItems.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent-templates", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const created = await createCustomAgentTemplate(dataRoot, {
        templateId: (body.template_id ?? body.templateId) as string,
        displayName: (body.display_name ?? body.displayName) as string | undefined,
        prompt: body.prompt as string,
        basedOnTemplateId: (body.based_on_template_id ?? body.basedOnTemplateId) as string | undefined
      });
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/agent-templates/:template_id", async (req, res, next) => {
    try {
      const templateId = req.params.template_id;
      const body = req.body as Record<string, unknown>;
      const updated = await patchCustomAgentTemplate(dataRoot, templateId, {
        displayName: (body.display_name ?? body.displayName) as string | undefined,
        prompt: body.prompt as string | undefined,
        basedOnTemplateId:
          body.based_on_template_id === null || body.basedOnTemplateId === null
            ? null
            : ((body.based_on_template_id ?? body.basedOnTemplateId) as string | undefined)
      });
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/agent-templates/:template_id", async (req, res, next) => {
    try {
      const removed = await deleteCustomAgentTemplate(dataRoot, req.params.template_id);
      res.status(200).json(removed);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/teams", async (_req, res, next) => {
    try {
      const teams = await listTeams(dataRoot);
      res.status(200).json({ items: teams, total: teams.length });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/teams/:teamId", async (req, res, next) => {
    try {
      const team = await getTeam(dataRoot, req.params.teamId);
      if (!team) {
        res.status(404).json({ error: `Team '${req.params.teamId}' not found` });
        return;
      }
      res.status(200).json(team);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/teams", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const created = await createTeam(dataRoot, {
        teamId: (body.team_id ?? body.teamId) as string,
        name: (body.name ?? body.team_id ?? body.teamId) as string,
        description: (body.description ?? body.description) as string | undefined,
        agentIds: (body.agent_ids ?? body.agentIds) as string[] | undefined,
        routeTable: (body.route_table ?? body.routeTable) as Record<string, string[]> | undefined,
        taskAssignRouteTable: (body.task_assign_route_table ?? body.taskAssignRouteTable) as
          | Record<string, string[]>
          | undefined,
        routeDiscussRounds: (body.route_discuss_rounds ?? body.routeDiscussRounds) as
          | Record<string, Record<string, number>>
          | undefined,
        agentModelConfigs: readAgentModelConfigsField(body.agent_model_configs ?? body.agentModelConfigs)
      });
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/teams/:teamId", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const updated = await updateTeam(dataRoot, req.params.teamId, {
        name: (body.name ?? body.name) as string | undefined,
        description: (body.description ?? body.description) as string | undefined,
        agentIds: (body.agent_ids ?? body.agentIds) as string[] | undefined,
        routeTable: (body.route_table ?? body.routeTable) as Record<string, string[]> | undefined,
        taskAssignRouteTable: (body.task_assign_route_table ?? body.taskAssignRouteTable) as
          | Record<string, string[]>
          | undefined,
        routeDiscussRounds: (body.route_discuss_rounds ?? body.routeDiscussRounds) as
          | Record<string, Record<string, number>>
          | undefined,
        agentModelConfigs: readAgentModelConfigsField(body.agent_model_configs ?? body.agentModelConfigs)
      });
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/teams/:teamId", async (req, res, next) => {
    try {
      const removed = await deleteTeam(dataRoot, req.params.teamId);
      if (!removed) {
        res.status(404).json({ error: `Team '${req.params.teamId}' not found` });
        return;
      }
      res.status(200).json({ removed: true });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/agents", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const agentId = (body.agent_id ?? body.agentId) as string | undefined;
      const displayName = (body.display_name ?? body.displayName) as string | undefined;
      const prompt = body.prompt as string | undefined;
      const summary = readStringField(body, ["summary"]);
      const defaultProviderId = body.provider_id as string | undefined;
      const defaultModelParams = (body.default_model_params ?? body.defaultModelParams) as
        | Record<string, any>
        | undefined;
      const modelSelectionEnabled = (body.model_selection_enabled ?? body.modelSelectionEnabled) as boolean | undefined;
      let skillList: string[] | undefined;
      if (
        Object.prototype.hasOwnProperty.call(body, "skill_list") ||
        Object.prototype.hasOwnProperty.call(body, "skillList")
      ) {
        const raw = body.skill_list ?? body.skillList;
        if (raw === null) {
          skillList = [];
        } else if (Array.isArray(raw)) {
          skillList = raw
            .map((item) => (typeof item === "string" ? item.trim() : String(item).trim()))
            .filter((item, index, list) => item.length > 0 && list.indexOf(item) === index);
        } else {
          sendApiError(res, 400, "AGENT_INPUT_INVALID", "skill_list must be an array of list ids");
          return;
        }
      }
      if (!agentId || !prompt) {
        res.status(400).json({ error: "agent_id and prompt are required" });
        return;
      }
      if (skillList && skillList.length > 0) {
        const missing = await validateSkillListIds(dataRoot, skillList);
        if (missing.length > 0) {
          sendApiError(res, 400, "AGENT_SKILL_LIST_INVALID", `unknown skill lists: ${missing.join(", ")}`);
          return;
        }
      }
      const created = await createAgent(dataRoot, {
        agentId,
        displayName,
        prompt,
        summary,
        skillList,
        defaultCliTool:
          defaultProviderId !== undefined ? readProviderIdField(body, "provider_id", "minimax") : undefined,
        defaultModelParams,
        modelSelectionEnabled
      });
      const { defaultCliTool, skillList: createdSkillList, ...rest } = created;
      res.status(201).json({
        ...rest,
        provider_id: defaultCliTool,
        skill_list: createdSkillList ?? []
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/agents/:agent_id", async (req, res, next) => {
    try {
      const agentId = req.params.agent_id;
      const body = req.body as Record<string, unknown>;
      let skillListPatch: string[] | undefined;
      if (
        Object.prototype.hasOwnProperty.call(body, "skill_list") ||
        Object.prototype.hasOwnProperty.call(body, "skillList")
      ) {
        const raw = body.skill_list ?? body.skillList;
        if (raw === null) {
          skillListPatch = [];
        } else if (Array.isArray(raw)) {
          skillListPatch = raw
            .map((item) => (typeof item === "string" ? item.trim() : String(item).trim()))
            .filter((item, index, list) => item.length > 0 && list.indexOf(item) === index);
        } else {
          sendApiError(res, 400, "AGENT_INPUT_INVALID", "skill_list must be an array of list ids");
          return;
        }
      }
      if (skillListPatch && skillListPatch.length > 0) {
        const missing = await validateSkillListIds(dataRoot, skillListPatch);
        if (missing.length > 0) {
          sendApiError(res, 400, "AGENT_SKILL_LIST_INVALID", `unknown skill lists: ${missing.join(", ")}`);
          return;
        }
      }
      const updated = await patchAgent(dataRoot, agentId, {
        displayName: (body.display_name ?? body.displayName) as string | undefined,
        prompt: body.prompt as string | undefined,
        summary: readNullableStringPatch(body, ["summary"]),
        skillList: skillListPatch,
        defaultCliTool:
          body.provider_id !== undefined ? readProviderIdField(body, "provider_id", "minimax") : undefined,
        defaultModelParams: (body.default_model_params ?? body.defaultModelParams) as Record<string, any> | undefined,
        modelSelectionEnabled: (body.model_selection_enabled ?? body.modelSelectionEnabled) as boolean | undefined
      });
      const { defaultCliTool, skillList, ...rest } = updated;
      res.status(200).json({
        ...rest,
        provider_id: defaultCliTool,
        skill_list: skillList ?? []
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/agents/:agent_id", async (req, res, next) => {
    try {
      const removed = await deleteAgent(dataRoot, req.params.agent_id);
      res.status(200).json(removed);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/skills", async (_req, res, next) => {
    try {
      const items = await listSkills(dataRoot);
      res.status(200).json({ items, total: items.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/skills/import", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const sourceRaw = body.sources ?? body.paths ?? body.source;
      const sources = Array.isArray(sourceRaw)
        ? sourceRaw
            .map((item) => (typeof item === "string" ? item.trim() : String(item).trim()))
            .filter((item) => item.length > 0)
        : typeof sourceRaw === "string" && sourceRaw.trim().length > 0
          ? [sourceRaw.trim()]
          : [];
      if (sources.length === 0) {
        sendApiError(res, 400, "SKILL_IMPORT_INPUT_INVALID", "sources is required");
        return;
      }
      const recursive = parseBoolean(body.recursive, true);
      const result = await importSkills(dataRoot, { sources, recursive });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/skills/:skill_id", async (req, res, next) => {
    try {
      const removed = await deleteSkill(dataRoot, req.params.skill_id);
      res.status(200).json(removed);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/skill-lists", async (_req, res, next) => {
    try {
      const items = await listSkillLists(dataRoot);
      res.status(200).json({ items, total: items.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/skill-lists", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const listId = readStringField(body, ["list_id", "listId"]);
      if (!listId) {
        sendApiError(res, 400, "SKILL_LIST_INPUT_INVALID", "list_id is required");
        return;
      }
      const created = await createSkillList(dataRoot, {
        listId,
        displayName: readStringField(body, ["display_name", "displayName"]),
        description: readStringField(body, ["description"]),
        includeAll: parseBoolean(body.include_all ?? body.includeAll, false),
        skillIds: readStringArray(body.skill_ids ?? body.skillIds)
      });
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/skill-lists/:list_id", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const hasInclude =
        Object.prototype.hasOwnProperty.call(body, "include_all") ||
        Object.prototype.hasOwnProperty.call(body, "includeAll");
      const hasSkillIds =
        Object.prototype.hasOwnProperty.call(body, "skill_ids") ||
        Object.prototype.hasOwnProperty.call(body, "skillIds");
      const updated = await patchSkillList(dataRoot, req.params.list_id, {
        displayName: (body.display_name ?? body.displayName) as string | undefined,
        description: readNullableStringPatch(body, ["description"]),
        includeAll: hasInclude ? parseBoolean(body.include_all ?? body.includeAll, false) : undefined,
        skillIds: hasSkillIds ? (readStringArray(body.skill_ids ?? body.skillIds) ?? []) : undefined
      });
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/skill-lists/:list_id", async (req, res, next) => {
    try {
      const listId = req.params.list_id;
      const agents = await listAgents(dataRoot);
      const inUseBy = agents.find((agent) => (agent.skillList ?? []).includes(listId));
      if (inUseBy) {
        sendApiError(
          res,
          409,
          "SKILL_LIST_IN_USE",
          `skill list '${listId}' is used by agent '${inUseBy.agentId}' and cannot be deleted`
        );
        return;
      }
      const removed = await deleteSkillList(dataRoot, listId);
      res.status(200).json(removed);
    } catch (error) {
      next(error);
    }
  });
}

export function registerProjectRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot } = context;
  app.post("/api/projects", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      if ("auto_dispatch_limit" in body || "autoDispatchLimit" in body) {
        res.status(400).json({
          code: "PROJECT_PARAM_RETIRED",
          error: "auto_dispatch_limit is retired; use auto_dispatch_enabled + auto_dispatch_remaining"
        });
        return;
      }
      const projectId = body.project_id as string | undefined;
      const name = body.name as string | undefined;
      const workspacePath = body.workspace_path as string | undefined;
      const templateId = (body.template_id ?? body.templateId) as string | undefined;
      const teamId = (body.team_id ?? body.teamId) as string | undefined;

      let teamAgentIds: string[] | undefined;
      let teamRouteTable: Record<string, string[]> | undefined;
      let teamTaskAssignRouteTable: Record<string, string[]> | undefined;
      let teamRouteDiscussRounds: Record<string, Record<string, number>> | undefined;
      let teamAgentModelConfigs:
        | Record<string, { provider_id: ProviderId; model: string; effort?: "low" | "medium" | "high" }>
        | undefined;

      if (teamId) {
        const team = await getTeam(dataRoot, teamId);
        if (team) {
          teamAgentIds = team.agentIds;
          teamRouteTable = team.routeTable;
          teamTaskAssignRouteTable = team.taskAssignRouteTable;
          teamRouteDiscussRounds = team.routeDiscussRounds;
          teamAgentModelConfigs = team.agentModelConfigs;
        }
      }

      const agentIds = Array.isArray(body.agent_ids ?? body.agentIds)
        ? ((body.agent_ids ?? body.agentIds) as string[])
        : teamAgentIds;
      const routeTable =
        ((body.route_table ?? body.routeTable) as Record<string, string[]> | undefined) ?? teamRouteTable;
      const taskAssignRouteTable =
        ((body.task_assign_route_table ?? body.taskAssignRouteTable) as Record<string, string[]> | undefined) ??
        teamTaskAssignRouteTable;
      const routeDiscussRounds =
        ((body.route_discuss_rounds ?? body.routeDiscussRounds) as
          | Record<string, Record<string, number>>
          | undefined) ?? teamRouteDiscussRounds;
      const agentModelConfigs =
        readAgentModelConfigsField(body.agent_model_configs ?? body.agentModelConfigs) ?? teamAgentModelConfigs;
      const autoDispatchEnabled = parseBoolean(body.auto_dispatch_enabled ?? body.autoDispatchEnabled, true);
      const autoDispatchRemaining = parseInteger(body.auto_dispatch_remaining ?? body.autoDispatchRemaining) ?? 5;
      const holdEnabled = parseBoolean(body.hold_enabled ?? body.holdEnabled, false);
      const reminderModeRaw = body.reminder_mode ?? body.reminderMode;
      const reminderMode = parseReminderMode(reminderModeRaw) ?? "backoff";
      if (reminderModeRaw !== undefined && !parseReminderMode(reminderModeRaw)) {
        res.status(400).json({
          code: "ORCHESTRATOR_SETTINGS_INVALID",
          error: "reminder_mode must be backoff|fixed_interval"
        });
        return;
      }
      const roleSessionMap = (body.role_session_map ?? body.roleSessionMap) as Record<string, string> | undefined;

      if (!projectId || !name || !workspacePath) {
        res.status(400).json({ error: "project_id, name, workspace_path are required" });
        return;
      }

      const normalizedAgentIds = Array.isArray(agentIds)
        ? Array.from(new Set(agentIds.map((item) => String(item).trim()).filter((item) => item.length > 0)))
        : [];
      if (normalizedAgentIds.length > 0) {
        const registry = await listAgents(dataRoot);
        const known = new Set(registry.map((item) => item.agentId));
        const missing = normalizedAgentIds.filter((item) => !known.has(item));
        if (missing.length > 0) {
          res.status(400).json({ error: `agent_ids contain unregistered agents: ${missing.join(", ")}` });
          return;
        }
      }

      const created = await createProject(dataRoot, {
        projectId,
        name,
        workspacePath,
        templateId,
        agentIds,
        routeTable,
        routeDiscussRounds,
        autoDispatchEnabled,
        autoDispatchRemaining,
        holdEnabled,
        reminderMode,
        roleSessionMap
      });

      if (taskAssignRouteTable && Object.keys(taskAssignRouteTable).length > 0) {
        await updateTaskAssignRouting(dataRoot, created.project.projectId, taskAssignRouteTable);
      }

      if (agentModelConfigs && Object.keys(agentModelConfigs).length > 0) {
        await updateProjectRouting(dataRoot, created.project.projectId, {
          agentIds: created.project.agentIds ?? [],
          routeTable: created.project.routeTable ?? {},
          agentModelConfigs
        });
      }

      const templateApplyResult = await applyProjectTemplate(created.project);
      const scriptBootstrap = await ensureProjectAgentScripts(created.project);
      const agentList = await listAgents(dataRoot);
      const agentPrompts = new Map(agentList.map((item) => [item.agentId, item.prompt]));
      const agentSummaries = new Map(agentList.map((item) => [item.agentId, item.summary ?? ""]));
      const agentWorkspaceBootstrap = await ensureAgentWorkspaces(
        created.project,
        agentPrompts,
        undefined,
        agentSummaries
      );

      await appendEvent(created.paths, {
        projectId: created.project.projectId,
        eventType: "PROJECT_CREATED",
        source: "manager",
        payload: { name: created.project.name, workspacePath: created.project.workspacePath }
      });
      if (templateApplyResult.applied) {
        await appendEvent(created.paths, {
          projectId: created.project.projectId,
          eventType: "PROJECT_TEMPLATE_APPLIED",
          source: "manager",
          payload: {
            templateId: templateApplyResult.templateId,
            createdFiles: templateApplyResult.createdFiles,
            skippedFiles: templateApplyResult.skippedFiles
          }
        });
      }
      await appendEvent(created.paths, {
        projectId: created.project.projectId,
        eventType: "PROJECT_AGENT_SCRIPT_BOOTSTRAPPED",
        source: "manager",
        payload: { createdFiles: scriptBootstrap.createdFiles, skippedFiles: scriptBootstrap.skippedFiles }
      });
      await appendEvent(created.paths, {
        projectId: created.project.projectId,
        eventType: "PROJECT_AGENT_WORKSPACES_BOOTSTRAPPED",
        source: "manager",
        payload: {
          createdFiles: agentWorkspaceBootstrap.createdFiles,
          skippedFiles: agentWorkspaceBootstrap.skippedFiles
        }
      });

      res.status(201).json(created.project);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/projects", async (_req, res, next) => {
    try {
      const items = await listProjects(dataRoot);
      res.json({ items, total: items.length });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:id", async (req, res, next) => {
    try {
      const project = await getProjectOverview(dataRoot, req.params.id);
      res.json({
        ...project,
        autoDispatchEnabled: project.autoDispatchEnabled ?? true,
        autoDispatchRemaining: project.autoDispatchRemaining ?? 5
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:id/task-assign-routing", async (req, res, next) => {
    try {
      const project = await getProject(dataRoot, req.params.id);
      res.status(200).json({
        project_id: project.projectId,
        task_assign_route_table: project.taskAssignRouteTable ?? {},
        updated_at: project.updatedAt
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:id/route-targets", async (req, res, next) => {
    const startTime = Date.now();
    const projectId = req.params.id;
    const fromAgent = typeof req.query.from_agent === "string" ? req.query.from_agent : req.query.fromAgent;
    logger.info(`[API] GET /api/projects/${projectId}/route-targets?from_agent=${fromAgent} - request received`);

    try {
      const fromAgentQuery = typeof req.query.from_agent === "string" ? req.query.from_agent : req.query.fromAgent;
      const fromAgentTrim = typeof fromAgentQuery === "string" ? fromAgentQuery.trim() : "";
      if (!fromAgentTrim) {
        res.status(400).json({ error: "from_agent is required" });
        return;
      }
      const project = await getProject(dataRoot, req.params.id);
      const registry = await listAgents(dataRoot);
      const snapshot = buildProjectRoutingSnapshot(
        project,
        fromAgentTrim,
        registry.map((item) => item.agentId)
      );
      const duration = Date.now() - startTime;
      logger.info(`[API] GET /api/projects/${projectId}/route-targets - completed in ${duration}ms`);
      res.status(200).json(snapshot);
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`[API] GET /api/projects/${projectId}/route-targets - error after ${duration}ms: ${error}`);
      next(error);
    }
  });

  app.patch("/api/projects/:id/routing-config", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      if ("auto_dispatch_limit" in body || "autoDispatchLimit" in body) {
        res.status(400).json({
          code: "PROJECT_PARAM_RETIRED",
          error: "auto_dispatch_limit is retired. Use /api/projects/:id/orchestrator/settings"
        });
        return;
      }
      const project = await getProject(dataRoot, req.params.id);
      const agentIds = Array.isArray(body.agent_ids ?? body.agentIds)
        ? ((body.agent_ids ?? body.agentIds) as string[])
        : null;
      const routeTable = (body.route_table ?? body.routeTable) as Record<string, string[]> | undefined;
      const routeDiscussRounds = (body.route_discuss_rounds ?? body.routeDiscussRounds) as
        | Record<string, Record<string, number>>
        | undefined;
      const agentModelConfigs = readAgentModelConfigsField(body.agent_model_configs ?? body.agentModelConfigs);
      if (!agentIds || !routeTable || typeof routeTable !== "object") {
        res.status(400).json({ error: "agent_ids and route_table are required" });
        return;
      }
      const normalizedAgentIds = Array.from(
        new Set(agentIds.map((item) => String(item).trim()).filter((item) => item.length > 0))
      );
      const registry = await listAgents(dataRoot);
      const known = new Set(registry.map((item) => item.agentId));
      const missing = normalizedAgentIds.filter((item) => !known.has(item));
      if (missing.length > 0) {
        res.status(400).json({ error: `agent_ids contain unregistered agents: ${missing.join(", ")}` });
        return;
      }

      const updated = await updateProjectRouting(dataRoot, project.projectId, {
        agentIds: normalizedAgentIds,
        routeTable,
        routeDiscussRounds,
        agentModelConfigs
      });

      await appendEvent(await ensureProjectRuntime(dataRoot, project.projectId), {
        projectId: project.projectId,
        eventType: "PROJECT_ROUTING_UPDATED",
        source: "dashboard",
        payload: {
          agentCount: updated.agentIds?.length ?? 0,
          routeEdgeCount: Object.values(updated.routeTable ?? {}).reduce((acc, item) => acc + item.length, 0)
        }
      });
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/projects/:id/task-assign-routing", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const taskAssignRouteTable = body.task_assign_route_table ?? body.taskAssignRouteTable;
      if (!taskAssignRouteTable || typeof taskAssignRouteTable !== "object") {
        res.status(400).json({
          code: "TASK_ASSIGN_ROUTING_INVALID",
          error: "task_assign_route_table is required and must be an object"
        });
        return;
      }
      const updated = await updateTaskAssignRouting(
        dataRoot,
        req.params.id,
        taskAssignRouteTable as Record<string, string[]>
      );
      res.status(200).json({
        project_id: updated.projectId,
        task_assign_route_table: updated.taskAssignRouteTable ?? {},
        updated_at: updated.updatedAt
      });
    } catch (error) {
      if (error instanceof ProjectStoreError) {
        res.status(400).json({
          code: "TASK_ASSIGN_ROUTING_INVALID",
          error: error.message
        });
        return;
      }
      next(error);
    }
  });

  app.get("/api/projects/:id/orchestrator/settings", async (req, res, next) => {
    try {
      const project = await getProject(dataRoot, req.params.id);
      res.status(200).json({
        project_id: project.projectId,
        auto_dispatch_enabled: project.autoDispatchEnabled ?? true,
        auto_dispatch_remaining: project.autoDispatchRemaining ?? 5,
        hold_enabled: project.holdEnabled ?? false,
        reminder_mode: project.reminderMode ?? "backoff",
        updated_at: project.updatedAt
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/projects/:id/orchestrator/settings", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const enabledRaw = body.auto_dispatch_enabled ?? body.autoDispatchEnabled;
      const remainingRaw = body.auto_dispatch_remaining ?? body.autoDispatchRemaining;
      const holdRaw = body.hold_enabled ?? body.holdEnabled;
      const reminderModeRaw = body.reminder_mode ?? body.reminderMode;
      const hasEnabled = typeof enabledRaw === "boolean";
      const remainingParsed = parseInteger(remainingRaw);
      const hasRemaining = remainingRaw !== undefined;
      const hasHold = typeof holdRaw === "boolean";
      const parsedReminderMode = parseReminderMode(reminderModeRaw);
      const hasReminderMode = reminderModeRaw !== undefined;
      if (hasReminderMode && !parsedReminderMode) {
        res.status(400).json({
          code: "ORCHESTRATOR_SETTINGS_INVALID",
          error: "reminder_mode must be backoff|fixed_interval"
        });
        return;
      }
      if (!hasEnabled && !hasRemaining && !hasHold && !hasReminderMode) {
        res.status(400).json({
          code: "ORCHESTRATOR_SETTINGS_INVALID",
          error:
            "at least one of auto_dispatch_enabled, auto_dispatch_remaining, hold_enabled, reminder_mode is required"
        });
        return;
      }
      if (hasRemaining && (remainingParsed === undefined || remainingParsed < 0 || remainingParsed > 1000)) {
        res.status(400).json({
          code: "ORCHESTRATOR_SETTINGS_INVALID",
          error: "auto_dispatch_remaining must be integer in [0,1000]"
        });
        return;
      }
      const updated = await updateProjectOrchestratorSettings(dataRoot, req.params.id, {
        autoDispatchEnabled: hasEnabled ? Boolean(enabledRaw) : undefined,
        autoDispatchRemaining: hasRemaining ? remainingParsed : undefined,
        holdEnabled: hasHold ? Boolean(holdRaw) : undefined,
        reminderMode: hasReminderMode ? parsedReminderMode : undefined
      });
      res.status(200).json({
        project_id: updated.projectId,
        auto_dispatch_enabled: updated.autoDispatchEnabled ?? true,
        auto_dispatch_remaining: updated.autoDispatchRemaining ?? 5,
        hold_enabled: updated.holdEnabled ?? false,
        reminder_mode: updated.reminderMode ?? "backoff",
        updated_at: updated.updatedAt
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/projects/:id", async (req, res, next) => {
    try {
      const removed = await deleteProject(dataRoot, req.params.id);
      res.status(200).json(removed);
    } catch (error) {
      next(error);
    }
  });
}

export function registerProjectRuntimeRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot, orchestrator, providerRegistry } = context;
  app.post("/api/projects/:id/sessions", async (req, res, next) => {
    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const body = req.body as Record<string, unknown>;
      const role = (body.role ?? body.to_role) as string | undefined;
      const status = body.status as string | undefined;
      const requestedSessionId = readStringField(body, ["session_id", "sessionId"]);
      const currentTaskId = (body.current_task_id ?? body.currentTaskId) as string | undefined;
      if (!role) {
        res.status(400).json({ error: "role is required" });
        return;
      }
      const configuredProviderId = project.agentModelConfigs?.[role]?.provider_id;
      if (
        configuredProviderId &&
        configuredProviderId !== "codex" &&
        configuredProviderId !== "trae" &&
        configuredProviderId !== "minimax"
      ) {
        sendApiError(
          res,
          409,
          "SESSION_PROVIDER_NOT_SUPPORTED",
          `role '${role}' is configured with unsupported provider '${configuredProviderId}'`,
          "Only codex, trae, and minimax providers are supported for session startup."
        );
        return;
      }
      const candidateSessionId = requestedSessionId ?? buildSessionId(role);
      const existingById = await getSession(paths, project.projectId, candidateSessionId);
      if (existingById && existingById.role !== role) {
        sendApiError(
          res,
          409,
          "SESSION_ROLE_MISMATCH",
          `session '${candidateSessionId}' belongs to role '${existingById.role}', not '${role}'`,
          "Use a role-matched session_id or omit session_id for auto generation."
        );
        return;
      }
      const active = await resolveActiveSessionForRole({
        dataRoot,
        project,
        paths,
        role,
        reason: "api_session_create"
      });
      if (active && active.status !== "dismissed" && active.sessionId !== candidateSessionId) {
        sendApiError(
          res,
          409,
          "SESSION_ROLE_CONFLICT",
          `role '${role}' already has active session '${active.sessionId}'`,
          "Dismiss/repair the existing role session before creating a new one."
        );
        return;
      }
      const roleProviderId = project.agentModelConfigs?.[role]?.provider_id ?? "minimax";
      const created = await addSession(paths, project.projectId, {
        sessionId: candidateSessionId,
        role,
        status,
        currentTaskId,
        providerSessionId: undefined,
        provider: roleProviderId
      });
      const mappingError = validateRoleSessionMapWrite(created.session.role, created.session.sessionId);
      if (!mappingError) {
        await setRoleSessionMapping(dataRoot, project.projectId, created.session.role, created.session.sessionId);
      }
      await orchestrator.resetRoleReminderOnManualAction(project.projectId, created.session.role, "session_created");
      const publicSession = sanitizeSessionForApi(created.session);
      res.status(created.created ? 201 : 200).json({
        session: publicSession,
        created: created.created,
        status: created.session.status
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:id/sessions", async (req, res, next) => {
    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const lockScope = createProjectLockScope(dataRoot, project.projectId, project.workspacePath);
      const [sessions, locks] = await Promise.all([listSessions(paths, project.projectId), listActiveLocks(lockScope)]);
      const roles = Array.from(new Set(sessions.map((session) => session.role)));
      const activeSessions: typeof sessions = [];
      for (const role of roles) {
        const active = await resolveActiveSessionForRole({
          dataRoot,
          project,
          paths,
          role,
          reason: "api_list_sessions"
        });
        if (active) {
          activeSessions.push(active);
        }
      }
      const items = activeSessions
        .map((session) => ({
          ...sanitizeSessionForApi(session),
          locksHeldCount: locks.filter(
            (lock) =>
              lock.ownerSessionId === session.sessionId &&
              lock.ownerDomain === "project" &&
              lock.ownerDomainId === project.projectId
          ).length
        }))
        .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
      res.json({ items, total: items.length });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/projects/:id/sessions/:session_id/dismiss", async (req, res, next) => {
    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const token = req.params.session_id;
      const session = await getSession(paths, project.projectId, token);
      if (!session) {
        res.status(404).json({ error: `session '${token}' not found` });
        return;
      }
      const processTermination = await orchestrator.terminateSessionProcess(
        project.projectId,
        session.sessionId,
        "session_dismissed_by_api"
      );
      const dismissed = await touchSession(paths, project.projectId, session.sessionId, {
        status: "dismissed",
        currentTaskId: null,
        lastInboxMessageId: null,
        agentPid: null
      });
      const mappingCleared = project.roleSessionMap?.[session.role] === session.sessionId;
      if (mappingCleared) {
        await clearRoleSessionMapping(dataRoot, project.projectId, session.role);
      }
      await orchestrator.resetRoleReminderOnManualAction(project.projectId, session.role, "session_dismissed");
      res.status(200).json({ session: sanitizeSessionForApi(dismissed), mappingCleared, processTermination });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects/:id/sessions/:session_id/repair", async (req, res, next) => {
    try {
      const targetStatus = readStringField(req.body as Record<string, unknown>, ["target_status", "targetStatus"]);
      if (targetStatus !== "idle" && targetStatus !== "blocked") {
        sendApiError(
          res,
          400,
          "SESSION_REPAIR_INVALID_TARGET",
          "target_status must be idle|blocked",
          "Use target_status=idle or target_status=blocked."
        );
        return;
      }
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const token = req.params.session_id;
      const session = await getSession(paths, project.projectId, token);
      if (!session) {
        sendApiError(res, 404, "SESSION_NOT_FOUND", `session '${token}' not found`);
        return;
      }
      const repaired = await orchestrator.repairSessionStatus(req.params.id, session.sessionId, targetStatus);
      await orchestrator.resetRoleReminderOnManualAction(project.projectId, repaired.role, "session_repaired");
      res.status(200).json(sanitizeSessionForApi(repaired));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:id/inbox/:role", async (req, res, next) => {
    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? limitRaw : undefined;
      const targetRole = req.params.role;
      const items = await listInboxMessages(paths, targetRole, limit);
      res.json({ items, total: items.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects/:id/messages/send", async (req, res, next) => {
    const startTime = Date.now();
    const projectId = req.params.id;
    const body = req.body as Record<string, unknown>;
    const messageType = body.message_type || body.messageType || "MANAGER_MESSAGE";
    const fromAgent = body.from_agent || body.fromAgent || "manager";
    logger.info(
      `[API] POST /api/projects/${projectId}/messages/send - message_type=${messageType}, from_agent=${fromAgent} - request received`
    );

    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const result = await handleManagerMessageSend(dataRoot, project, paths, body);
      res.status(201).json(result);
      const duration = Date.now() - startTime;
      logger.info(`[API] POST /api/projects/${projectId}/messages/send - completed in ${duration}ms`);
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`[API] POST /api/projects/${projectId}/messages/send - error after ${duration}ms: ${error}`);
      if (error instanceof ManagerMessageServiceError) {
        if (error.code === "ENDPOINT_RETIRED" && error.replacement) {
          res.status(error.status).json({
            code: error.code,
            error: "endpoint retired",
            replacement: error.replacement
          });
          return;
        }
        sendApiError(
          res,
          error.status,
          error.code,
          error.message,
          error.hint,
          error.details ? { details: error.details } : undefined
        );
        return;
      }
      if (error instanceof ManagerRoutingError) {
        res.status(409).json({
          error_code: error.code,
          error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
        });
        return;
      }
      next(error);
    }
  });

  app.post("/api/projects/:id/task-actions", async (req, res, next) => {
    const startTime = Date.now();
    const projectId = req.params.id;
    const requestBody = req.body as Record<string, unknown>;
    logger.info(
      `[API] POST /api/projects/${projectId}/task-actions - request received, body=${JSON.stringify(requestBody)}`
    );

    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
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
        const nextAction = error.hint ?? resolveTaskActionNextAction(error.code);
        res.status(error.status).json({
          error_code: error.code,
          error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {})
          },
          message: error.message,
          hint: nextAction,
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

  app.post("/api/projects/:id/orchestrator/dispatch", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const role = readStringField(body, ["role", "to_role", "toRole"]);
      const requestedSessionId = (body.session_id ?? body.sessionId) as string | undefined;
      let resolvedSessionId = requestedSessionId;
      if (role && requestedSessionId) {
        const requestedSession = await getSession(paths, project.projectId, requestedSessionId);
        if (!requestedSession) {
          sendApiError(
            res,
            404,
            "SESSION_NOT_FOUND",
            `session '${requestedSessionId}' not found`,
            "Provide an existing session_id, or omit session_id and dispatch by role."
          );
          return;
        }
        if (requestedSession.role !== role) {
          sendApiError(
            res,
            409,
            "SESSION_ROLE_MISMATCH",
            `session '${requestedSessionId}' does not belong to role '${role}'`,
            "Use a role-matched session_id, or omit session_id and dispatch by role."
          );
          return;
        }
      }
      if (!resolvedSessionId && role) {
        const active = await resolveActiveSessionForRole({
          dataRoot,
          project,
          paths,
          role,
          reason: "api_dispatch_by_role"
        });
        resolvedSessionId = active?.sessionId;
      }
      const result = await orchestrator.dispatchProject(req.params.id, {
        mode: "manual",
        sessionId: resolvedSessionId,
        taskId: (body.task_id ?? body.taskId) as string | undefined,
        force: Boolean(body.force ?? false),
        onlyIdle:
          body.only_idle === undefined && body.onlyIdle === undefined ? false : Boolean(body.only_idle ?? body.onlyIdle)
      });
      const dispatchedCount = result.results.filter((item) => item.outcome === "dispatched").length;
      if (Boolean(body.force ?? false) && dispatchedCount > 0) {
        const rolesToReset = Array.from(
          new Set(
            result.results
              .filter((item) => item.outcome === "dispatched")
              .map((item) => item.role)
              .filter((item) => typeof item === "string" && item.trim().length > 0)
          )
        );
        for (const roleToReset of rolesToReset) {
          await orchestrator.resetRoleReminderOnManualAction(
            project.projectId,
            roleToReset,
            "force_dispatch_succeeded"
          );
        }
      }
      res.status(200).json({ ...result, dispatchedCount });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects/:id/orchestrator/dispatch-message", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const messageId = (body.message_id ?? body.messageId) as string | undefined;
      if (!messageId || !messageId.trim()) {
        sendApiError(
          res,
          400,
          "DISPATCH_MESSAGE_ID_REQUIRED",
          "message_id is required",
          "Provide message_id from inbox/timeline item."
        );
        return;
      }
      const result = await orchestrator.dispatchMessage(req.params.id, {
        messageId: messageId.trim(),
        sessionId: (body.session_id ?? body.sessionId) as string | undefined,
        force: Boolean(body.force ?? false),
        onlyIdle:
          body.only_idle === undefined && body.onlyIdle === undefined ? false : Boolean(body.only_idle ?? body.onlyIdle)
      });
      const dispatchedCount = result.results.filter((item) => item.outcome === "dispatched").length;
      res.status(200).json({ ...result, dispatchedCount });
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/projects/:id/events", async (req, res, next) => {
    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const body = req.body as Record<string, unknown>;
      const eventType = body.event_type as string | undefined;
      const source = (body.source as "manager" | "agent" | "system" | "dashboard" | undefined) ?? "system";
      const payload = (body.payload as Record<string, unknown> | undefined) ?? {};
      if (!eventType) {
        sendApiError(res, 400, "EVENT_TYPE_REQUIRED", "event_type is required", "Provide event_type string.");
        return;
      }
      const event = await appendEvent(paths, {
        projectId: project.projectId,
        eventType,
        source,
        sessionId: readStringField(body, ["session_id", "sessionId"]),
        taskId: readStringField(body, ["task_id", "taskId"]),
        payload
      });
      res.status(201).json(event);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:id/events", async (req, res, next) => {
    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const since = typeof req.query.since === "string" ? req.query.since : undefined;
      const events = await listEvents(paths, since);
      const ndjson = eventsToNdjson(events);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.status(200).send(ndjson);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:id/agent-io/timeline", async (req, res, next) => {
    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? limitRaw : undefined;
      const timeline = await buildAgentIOTimeline(project, paths, { limit });
      res.status(200).json(timeline);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:id/task-tree", async (req, res, next) => {
    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const tasks = await listTasks(paths, project.projectId);
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
      const response = buildTaskTreeResponse({
        projectId: project.projectId,
        tasks,
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
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const taskId = req.params.task_id?.trim();
      if (!taskId) {
        res.status(400).json({ code: "TASK_ID_REQUIRED", error: "task_id is required" });
        return;
      }
      const tasks = await listTasks(paths, project.projectId);
      const task = tasks.find((item) => item.taskId === taskId);
      if (!task) {
        res.status(404).json({ code: "TASK_NOT_FOUND", error: `task '${taskId}' not found` });
        return;
      }
      const events = await listEvents(paths);
      const response = buildTaskDetailResponse({
        projectId: project.projectId,
        task,
        events
      });
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/projects/:id/tasks/:task_id", async (req, res, next) => {
    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const taskId = req.params.task_id?.trim();
      if (!taskId) {
        res.status(400).json({ code: "TASK_ID_REQUIRED", error: "task_id is required" });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const patch: import("../data/taskboard-store.js").TaskPatchInput = {};
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
      const { patchTask, recomputeRunnableStates } = await import("../data/taskboard-store.js");
      const { appendEvent } = await import("../data/event-store.js");
      const patched = await patchTask(paths, project.projectId, taskId, patch);
      await recomputeRunnableStates(paths, project.projectId);
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "TASK_UPDATED",
        source: "dashboard",
        taskId: patched.task.taskId,
        payload: { updates: patch }
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

  app.post("/api/projects/:id/locks/acquire", async (req, res, next) => {
    const startTime = Date.now();
    const projectId = req.params.id;
    const body = req.body as Record<string, unknown>;
    const sessionId = body.session_id;
    const lockKey = body.lock_key;
    logger.info(
      `[API] POST /api/projects/${projectId}/locks/acquire - session_id=${sessionId}, lock_key=${lockKey} - request received`
    );

    try {
      const project = await getProject(dataRoot, req.params.id);
      const body = req.body as Record<string, unknown>;
      const sessionId = body.session_id as string | undefined;
      const lockKey = body.lock_key as string | undefined;
      const targetTypeRaw = (body.target_type ?? body.targetType) as string | undefined;
      const targetType = targetTypeRaw === "file" || targetTypeRaw === "dir" ? targetTypeRaw : undefined;
      const ttlSeconds = body.ttl_seconds as number | undefined;
      const purpose = body.purpose as string | undefined;
      if (!sessionId || !lockKey || typeof ttlSeconds !== "number") {
        sendApiError(
          res,
          400,
          "LOCK_ACQUIRE_INPUT_INVALID",
          "session_id, lock_key, ttl_seconds are required",
          "Provide all three fields with ttl_seconds as a number."
        );
        return;
      }
      const lockScope = createProjectLockScope(dataRoot, project.projectId, project.workspacePath);
      const acquired = await acquireLock(lockScope, { sessionId, lockKey, targetType, ttlSeconds, purpose });
      if (acquired.kind === "acquired") {
        const duration = Date.now() - startTime;
        logger.info(
          `[API] POST /api/projects/${projectId}/locks/acquire - completed in ${duration}ms, result=acquired`
        );
        res.status(201).json({ result: "acquired", lock: acquired.lock });
        return;
      }
      if (acquired.kind === "stolen") {
        const duration = Date.now() - startTime;
        logger.info(`[API] POST /api/projects/${projectId}/locks/acquire - completed in ${duration}ms, result=stolen`);
        res.status(201).json({ result: "stolen", lock: acquired.lock, previousLock: acquired.previousLock });
        return;
      }
      const duration = Date.now() - startTime;
      logger.info(`[API] POST /api/projects/${projectId}/locks/acquire - completed in ${duration}ms, result=failed`);
      res.status(409).json({ result: "failed", reason: acquired.reason, existingLock: acquired.existingLock });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`[API] POST /api/projects/${projectId}/locks/acquire - error after ${duration}ms: ${error}`);
      next(error);
    }
  });

  app.post("/api/projects/:id/locks/renew", async (req, res, next) => {
    const startTime = Date.now();
    const projectId = req.params.id;
    const body = req.body as Record<string, unknown>;
    const sessionId = body.session_id;
    const lockKey = body.lock_key;
    logger.info(
      `[API] POST /api/projects/${projectId}/locks/renew - session_id=${sessionId}, lock_key=${lockKey} - request received`
    );

    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const body = req.body as Record<string, unknown>;
      const sessionId = body.session_id as string | undefined;
      const lockKey = body.lock_key as string | undefined;
      if (!sessionId || !lockKey) {
        sendApiError(
          res,
          400,
          "LOCK_RENEW_INPUT_INVALID",
          "session_id, lock_key are required",
          "Provide both session_id and lock_key."
        );
        return;
      }
      const lockScope = createProjectLockScope(dataRoot, project.projectId, project.workspacePath);
      const renewed = await renewLock(lockScope, { sessionId, lockKey });
      if (renewed.kind === "renewed") {
        const duration = Date.now() - startTime;
        logger.info(`[API] POST /api/projects/${projectId}/locks/renew - completed in ${duration}ms, result=renewed`);
        res.status(200).json({ result: "renewed", lock: renewed.lock });
        return;
      }
      if (renewed.kind === "not_found") {
        const duration = Date.now() - startTime;
        logger.info(`[API] POST /api/projects/${projectId}/locks/renew - completed in ${duration}ms, result=not_found`);
        sendApiError(res, 404, "LOCK_NOT_FOUND", "lock not found", "Acquire lock first.");
        return;
      }
      if (renewed.kind === "not_owner") {
        const duration = Date.now() - startTime;
        logger.info(`[API] POST /api/projects/${projectId}/locks/renew - completed in ${duration}ms, result=not_owner`);
        sendApiError(
          res,
          403,
          "LOCK_NOT_OWNER",
          "lock owned by another session",
          "Only lock owner can renew; use the owner session or reacquire after expiry.",
          { existingLock: renewed.existingLock }
        );
        return;
      }
      sendApiError(res, 409, "LOCK_EXPIRED", "lock expired", "Reacquire lock before continuing.", {
        existingLock: renewed.existingLock
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`[API] POST /api/projects/${projectId}/locks/renew - error after ${duration}ms: ${error}`);
      next(error);
    }
  });

  app.post("/api/projects/:id/locks/release", async (req, res, next) => {
    const startTime = Date.now();
    const projectId = req.params.id;
    const body = req.body as Record<string, unknown>;
    const sessionId = body.session_id;
    const lockKey = body.lock_key;
    logger.info(
      `[API] POST /api/projects/${projectId}/locks/release - session_id=${sessionId}, lock_key=${lockKey} - request received`
    );

    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const body = req.body as Record<string, unknown>;
      const sessionId = body.session_id as string | undefined;
      const lockKey = body.lock_key as string | undefined;
      if (!sessionId || !lockKey) {
        sendApiError(
          res,
          400,
          "LOCK_RELEASE_INPUT_INVALID",
          "session_id, lock_key are required",
          "Provide both session_id and lock_key."
        );
        return;
      }
      const lockScope = createProjectLockScope(dataRoot, project.projectId, project.workspacePath);
      const released = await releaseLock(lockScope, { sessionId, lockKey });
      if (released.kind === "released") {
        const duration = Date.now() - startTime;
        logger.info(
          `[API] POST /api/projects/${projectId}/locks/release - completed in ${duration}ms, result=released`
        );
        res.status(200).json({ result: "released", lock: released.lock });
        return;
      }
      if (released.kind === "not_found") {
        const duration = Date.now() - startTime;
        logger.info(
          `[API] POST /api/projects/${projectId}/locks/release - completed in ${duration}ms, result=not_found`
        );
        sendApiError(res, 404, "LOCK_NOT_FOUND", "lock not found", "Lock may already be released.");
        return;
      }
      const duration = Date.now() - startTime;
      logger.info(`[API] POST /api/projects/${projectId}/locks/release - completed in ${duration}ms, result=not_owner`);
      sendApiError(
        res,
        403,
        "LOCK_NOT_OWNER",
        "lock owned by another session",
        "Only lock owner can release this lock.",
        { existingLock: released.existingLock }
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`[API] POST /api/projects/${projectId}/locks/release - error after ${duration}ms: ${error}`);
      next(error);
    }
  });

  app.get("/api/projects/:id/locks", async (req, res, next) => {
    const startTime = Date.now();
    const projectId = req.params.id;
    logger.info(`[API] GET /api/projects/${projectId}/locks - request received`);

    try {
      const project = await getProject(dataRoot, req.params.id);
      const lockScope = createProjectLockScope(dataRoot, project.projectId, project.workspacePath);
      const items = await listActiveLocks(lockScope);
      const duration = Date.now() - startTime;
      logger.info(`[API] GET /api/projects/${projectId}/locks - completed in ${duration}ms`);
      res.json({ items, total: items.length });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`[API] GET /api/projects/${projectId}/locks - error after ${duration}ms: ${error}`);
      next(error);
    }
  });

  app.get("/api/projects/:id/codex-output", async (req, res, next) => {
    try {
      const project = await getProject(dataRoot, req.params.id);
      const auditDir = path.join(dataRoot, "projects", project.projectId, "collab", "audit");
      const filePath = path.join(auditDir, "agent_output.jsonl");
      try {
        const content = await fs.readFile(filePath, "utf-8");
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.status(200).send(content);
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === "ENOENT") {
          res.status(404).json({ error: "agent_output.jsonl not found", path: filePath });
          return;
        }
        throw err;
      }
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/projects/:id/agent-chat", async (req, res, next) => {
    const projectId = req.params.id;
    const body = req.body as Record<string, unknown>;
    const role = (body.role as string)?.trim();
    const prompt = (body.prompt as string)?.trim();
    const sessionId = (body.sessionId as string)?.trim();
    const providerSessionId = (body.providerSessionId as string)?.trim();

    logger.info(
      `[API] POST /api/projects/${projectId}/agent-chat - role=${role}, sessionId=${sessionId}, providerSessionId=${providerSessionId} - request received`
    );

    if (!role) {
      sendApiError(res, 400, "ROLE_REQUIRED", "role is required", "Provide the agent role to chat with.");
      return;
    }
    if (!prompt) {
      sendApiError(res, 400, "PROMPT_REQUIRED", "prompt is required", "Provide the message to send to the agent.");
      return;
    }

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    function sendEvent(event: string, data: unknown) {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    try {
      const project = await getProject(dataRoot, projectId);
      const paths = await ensureProjectRuntime(dataRoot, projectId);
      const settings = await getRuntimeSettings(dataRoot);
      const providerId = resolveSessionProviderId(project, role, "minimax");
      const agents = await listAgents(dataRoot);
      const roleAgent = agents.find((item) => item.agentId === role);
      const rolePrompt = roleAgent?.prompt;
      const skillIds = await resolveSkillIdsForAgent(dataRoot, roleAgent?.skillList);
      const importedSkillPrompt = await resolveImportedSkillPromptSegments(dataRoot, skillIds);

      // Use the sessionId from request if provided, otherwise create new one
      const chatSessionId = sessionId || `agent-chat-${Date.now()}-${randomUUID().slice(0, 8)}`;
      // Use agent's personal workspace: <project-workspace>/Agents/<role>/
      const agentWorkspaceDir = path.join(project.workspacePath, "Agents", role);

      sendEvent("session", { sessionId: chatSessionId, providerSessionId });
      await providerRegistry.runSessionWithTools(providerId, settings, {
        prompt,
        providerSessionId: providerSessionId || chatSessionId,
        workspaceDir: agentWorkspaceDir,
        workspaceRoot: project.workspacePath,
        role,
        rolePrompt,
        skillSegments: importedSkillPrompt.segments,
        skillIds,
        contextKind: "project_agent_chat",
        runtimeConstraints: ["Use task-actions for coordination changes and progress reporting."],
        sessionDirFallback: path.join(paths.projectRootDir, ".minimax", "sessions"),
        apiBaseFallback: "https://api.minimax.io/v1",
        modelFallback: "MiniMax-Text-01",
        env: {
          AUTO_DEV_PROJECT_ID: projectId,
          AUTO_DEV_SESSION_ID: chatSessionId,
          AUTO_DEV_AGENT_ROLE: role,
          AUTO_DEV_PROJECT_ROOT: project.workspacePath,
          AUTO_DEV_AGENT_WORKSPACE: agentWorkspaceDir,
          AUTO_DEV_MANAGER_URL: process.env.AUTO_DEV_MANAGER_URL ?? "http://127.0.0.1:43123"
        },
        callback: {
          onThinking: (thinking: string) => {
            sendEvent("thinking", { thinking });
          },
          onToolCall: (name: string, args: Record<string, unknown>) => {
            sendEvent("tool_call", { name, args });
          },
          onToolResult: (name: string, result: { success: boolean; content: string; error?: string }) => {
            sendEvent("tool_result", { name, result });
          },
          onStep: (step: number, maxSteps: number) => {
            sendEvent("step", { step, maxSteps });
          },
          onMessage: (role: string, content: string) => {
            sendEvent("message", { role, content });
          },
          onError: (error: Error) => {
            sendEvent("error", { message: error.message });
          },
          onComplete: (result: string, finishReason?: string, meta?) => {
            sendEvent("complete", {
              result,
              finishReason,
              usage: meta?.usage,
              recoveredFromMaxTokens: meta?.recoveredFromMaxTokens ?? false
            });
          }
        }
      });

      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(`[API] POST /api/projects/${projectId}/agent-chat - error: ${error}`);
      sendEvent("error", { message });
      res.end();
    }
  });

  // POST /api/projects/:id/agent-chat/:sessionId/interrupt
  app.post("/api/projects/:id/agent-chat/:sessionId/interrupt", async (req, res, next) => {
    const startTime = Date.now();
    const projectId = req.params.id;
    const sessionId = req.params.sessionId;

    logger.info(`[API] POST /api/projects/${projectId}/agent-chat/${sessionId}/interrupt - request received`);

    try {
      const paths = await ensureProjectRuntime(dataRoot, projectId);
      const existingSession = await getSession(paths, projectId, sessionId);
      const providerId = existingSession?.provider ?? "minimax";
      const cancelled = providerRegistry.cancelSession(providerId, sessionId);
      const duration = Date.now() - startTime;
      logger.info(
        `[API] POST /api/projects/${projectId}/agent-chat/${sessionId}/interrupt - completed in ${duration}ms, cancelled=${cancelled}`
      );

      res.json({ success: true, cancelled });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(
        `[API] POST /api/projects/${projectId}/agent-chat/${sessionId}/interrupt - error after ${duration}ms: ${error}`
      );
      next(error);
    }
  });
}

export function registerApiErrorMiddleware(app: express.Application): void {
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ProjectStoreError) {
      if (error.code === "PROJECT_EXISTS") {
        sendApiError(res, 409, "PROJECT_EXISTS", error.message, "Use another project_id or delete existing project.");
        return;
      }
      if (error.code === "PROJECT_NOT_FOUND") {
        sendApiError(res, 404, "PROJECT_NOT_FOUND", error.message, "Check project id.");
        return;
      }
      if (error.code === "INVALID_PROJECT_ID") {
        sendApiError(res, 400, "INVALID_PROJECT_ID", error.message, "Use lowercase letters, numbers, '-' or '_'.");
        return;
      }
      if (error.code === "INVALID_ROUTE_TABLE") {
        sendApiError(res, 400, "INVALID_ROUTE_TABLE", error.message);
        return;
      }
    }
    if (error instanceof WorkflowStoreError) {
      if (error.code === "TEMPLATE_EXISTS") {
        sendApiError(res, 409, "WORKFLOW_TEMPLATE_EXISTS", error.message);
        return;
      }
      if (error.code === "RUN_EXISTS") {
        sendApiError(res, 409, "WORKFLOW_RUN_EXISTS", error.message);
        return;
      }
      if (error.code === "TEMPLATE_NOT_FOUND") {
        sendApiError(res, 404, "WORKFLOW_TEMPLATE_NOT_FOUND", error.message);
        return;
      }
      if (error.code === "RUN_NOT_FOUND") {
        sendApiError(res, 404, "WORKFLOW_RUN_NOT_FOUND", error.message);
        return;
      }
      if (error.code === "INVALID_TEMPLATE_ID" || error.code === "INVALID_RUN_ID") {
        sendApiError(res, 400, error.code, error.message);
        return;
      }
      sendApiError(res, 400, "WORKFLOW_STORE_ERROR", error.message);
      return;
    }
    if (error instanceof WorkflowRuntimeError) {
      sendApiError(
        res,
        error.status,
        error.code,
        error.message,
        error.hint,
        error.details ? { details: error.details } : undefined
      );
      return;
    }
    if (error instanceof LockStoreError) {
      sendApiError(res, 400, "LOCK_STORE_ERROR", error.message);
      return;
    }
    if (error instanceof TaskboardStoreError) {
      if (error.code === "TASK_EXISTS") {
        sendApiError(res, 409, "TASK_EXISTS", error.message, "Use unique task_id.");
        return;
      }
      if (error.code === "TASK_NOT_FOUND") {
        sendApiError(res, 404, "TASK_NOT_FOUND", error.message, "Check task_id.");
        return;
      }
      if (
        error.code === "TASK_DEPENDENCY_CYCLE" ||
        error.code === "TASK_DEPENDENCY_CROSS_ROOT" ||
        error.code === "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN"
      ) {
        sendApiError(res, 409, error.code, error.message, undefined, { details: error.details ?? null });
        return;
      }
      sendApiError(res, 400, "TASKBOARD_ERROR", error.message, undefined, { details: error.details ?? null });
      return;
    }
    if (error instanceof SessionStoreError) {
      if (error.code === "SESSION_NOT_FOUND") {
        sendApiError(res, 404, "SESSION_NOT_FOUND", error.message, "Create or resolve valid session_id.");
        return;
      }
      sendApiError(res, 400, "SESSION_STORE_ERROR", error.message);
      return;
    }
    if (error instanceof AgentStoreError) {
      if (error.code === "AGENT_EXISTS") {
        sendApiError(res, 409, "AGENT_EXISTS", error.message);
        return;
      }
      if (error.code === "AGENT_NOT_FOUND") {
        sendApiError(res, 404, "AGENT_NOT_FOUND", error.message);
        return;
      }
      sendApiError(res, 400, "AGENT_STORE_ERROR", error.message);
      return;
    }
    if (error instanceof AgentTemplateStoreError) {
      if (error.code === "TEMPLATE_EXISTS") {
        sendApiError(res, 409, "TEMPLATE_EXISTS", error.message);
        return;
      }
      if (error.code === "TEMPLATE_NOT_FOUND") {
        sendApiError(res, 404, "TEMPLATE_NOT_FOUND", error.message);
        return;
      }
      sendApiError(res, 400, "TEMPLATE_STORE_ERROR", error.message);
      return;
    }
    if (error instanceof SkillStoreError) {
      if (error.code === "SKILL_NOT_FOUND") {
        sendApiError(res, 404, "SKILL_NOT_FOUND", error.message);
        return;
      }
      if (error.code === "SKILL_LIST_NOT_FOUND") {
        sendApiError(res, 404, "SKILL_LIST_NOT_FOUND", error.message);
        return;
      }
      if (error.code === "SKILL_LIST_EXISTS") {
        sendApiError(res, 409, "SKILL_LIST_EXISTS", error.message);
        return;
      }
      if (error.code === "INVALID_SKILL_REFERENCE") {
        sendApiError(res, 400, "INVALID_SKILL_REFERENCE", error.message);
        return;
      }
      sendApiError(res, 400, "SKILL_STORE_ERROR", error.message);
      return;
    }
    if (error instanceof TeamToolsTemplateError) {
      sendApiError(
        res,
        500,
        error.code,
        error.message,
        "Ensure repository root has TeamsTools/ template files or set AUTO_DEV_TEAMTOOLS_SOURCE."
      );
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    sendApiError(res, 500, "INTERNAL_SERVER_ERROR", message, "Inspect server logs for stack trace.");
  });
}
