import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendEvent, eventsToNdjson, listEvents } from "./data/event-store.js";
import { logger } from "./utils/logger.js";
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
} from "./data/project-store.js";
import { ProjectStoreError } from "./data/project-store.js";
import { acquireLock, listActiveLocks, LockStoreError, releaseLock, renewLock } from "./data/lock-store.js";
import { listTasks, TaskboardStoreError } from "./data/taskboard-store.js";
import { listInboxMessages } from "./data/inbox-store.js";
import { getRuntimeSettings, patchRuntimeSettings } from "./data/runtime-settings-store.js";
import { createAgent, deleteAgent, listAgents, patchAgent, AgentStoreError } from "./data/agent-store.js";
import {
  AgentTemplateStoreError,
  createCustomAgentTemplate,
  deleteCustomAgentTemplate,
  listCustomAgentTemplates,
  patchCustomAgentTemplate
} from "./data/agent-template-store.js";
import {
  createTeam,
  deleteTeam,
  getTeam,
  listTeams,
  updateTeam
} from "./data/team-store.js";
import {
  addSession,
  listSessions,
  resolveSessionByIdOrKey,
  resolveLatestSessionByRole,
  SessionStoreError,
  touchSession
} from "./data/session-store.js";
import { BASE_PROMPT_TEXT, BASE_PROMPT_VERSION, getBuiltInAgents } from "./services/agent-prompt-service.js";
import { createOrchestratorService } from "./services/orchestrator-service.js";
import { applyProjectTemplate } from "./services/project-template-service.js";
import { buildAgentIOTimeline } from "./services/agent-io-timeline-service.js";
import { ensureProjectAgentScripts, TeamToolsTemplateError } from "./services/project-agent-script-service.js";
import { ensureAgentWorkspaces } from "./services/agent-workspace-service.js";
import { buildProjectRoutingSnapshot } from "./services/project-routing-snapshot-service.js";
import { createModelManagerService } from "./services/model-manager-service.js";
import {
  validateRoleSessionMapWrite
} from "./services/routing-guard-service.js";
import { ManagerRoutingError } from "./services/manager-routing-service.js";
import { handleTaskAction, TaskActionError } from "./services/task-action-service.js";
import { handleManagerMessageSend, ManagerMessageServiceError } from "./services/manager-message-service.js";
import { buildTaskTreeResponse } from "./services/task-tree-query-service.js";
import { buildTaskDetailResponse } from "./services/task-detail-query-service.js";
import { createMiniMaxAgent } from "./minimax/index.js";
import { cancelMiniMaxRunner } from "./services/minimax-runner.js";

export interface AppOptions {
  dataRoot?: string;
}

export function resolveDataRoot(explicitDataRoot?: string): string {
  if (explicitDataRoot) {
    return path.resolve(explicitDataRoot);
  }
  if (process.env.FRAMEWORK_DATA_ROOT) {
    return path.resolve(process.env.FRAMEWORK_DATA_ROOT);
  }
  return path.resolve(process.cwd(), "..", "data");
}

function readStringField(body: Record<string, unknown>, keys: string[], fallback?: string): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return fallback;
}

function parseInteger(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function parseBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") {
    return raw;
  }
  return fallback;
}

function buildPendingSessionId(role: string): string {
  const safeRole = role.replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const random = Math.random().toString(36).slice(2, 10);
  return `pending-${safeRole}-${random}`;
}

function retiredEndpoint(res: express.Response, replacement: string): void {
  res.status(410).json({
    code: "ENDPOINT_RETIRED",
    error: "endpoint retired",
    replacement
  });
}

function sendApiError(
  res: express.Response,
  status: number,
  code: string,
  message: string,
  hint?: string,
  extra?: Record<string, unknown>
): void {
  const details = extra && typeof extra.details === "object" && extra.details
    ? (extra.details as Record<string, unknown>)
    : undefined;
  res.status(status).json({
    error_code: code,
    error: { code, message, ...(details ? { details } : {}) },
    message,
    hint: hint ?? null,
    next_action: hint ?? null,
    ...(extra ?? {})
  });
}

function resolveTaskActionNextAction(code: string): string | null {
  switch (code) {
    case "TASK_PROGRESS_REQUIRED":
      return "Update Agents/<role>/progress.md with concrete evidence and reported task_id, then resend once.";
    case "TASK_RESULT_INVALID_TARGET":
      return "Report only tasks owned by your role or created by your role.";
    case "TASK_BINDING_REQUIRED":
      return "Fill required task binding fields (task_id, owner_role, or discuss target).";
    case "TASK_ROUTE_DENIED":
      return "Choose an allowed route target or request route-table update.";
    case "TASK_REPORT_NO_STATE_CHANGE":
      return "Do not resend identical report. Add new progress or report unresolved tasks.";
    case "TASK_STATE_STALE":
      return "Task state is already newer than this transition. Keep same-state report or continue with downstream tasks.";
    case "TASK_ACTION_INVALID":
      return "Fix payload schema for selected action_type and retry once.";
    default:
      return null;
  }
}


export function createApp(options: AppOptions = {}) {
  const app = express();
  const dataRoot = resolveDataRoot(options.dataRoot);
  const orchestrator = createOrchestratorService(dataRoot);
  orchestrator.start();

  const corsAllowList = (
    process.env.AUTO_DEV_CORS_ORIGINS ??
    "http://localhost:5174,http://127.0.0.1:5174,http://localhost:5173,http://127.0.0.1:5173"
  )
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const corsAllowSet = new Set(corsAllowList);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && corsAllowSet.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: "10mb" }));

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
      res.status(200).json({
        codexCliCommand: settings.codexCliCommand,
        traeCliCommand: settings.traeCliCommand,
        minimaxApiKey: settings.minimaxApiKey,
        minimaxApiBase: settings.minimaxApiBase,
        minimaxModel: settings.minimaxModel,
        minimaxSessionDir: settings.minimaxSessionDir,
        minimaxMcpServers: settings.minimaxMcpServers,
        minimaxMaxSteps: settings.minimaxMaxSteps,
        minimaxTokenLimit: settings.minimaxTokenLimit,
        updatedAt: settings.updatedAt
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/settings", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const updated = await patchRuntimeSettings(dataRoot, {
        codexCliCommand: readStringField(body, ["codex_cli_command", "codexCliCommand"]),
        traeCliCommand: readStringField(body, ["trae_cli_command", "traeCliCommand"]),
        minimaxApiKey: readStringField(body, ["minimax_api_key", "minimaxApiKey"]),
        minimaxApiBase: readStringField(body, ["minimax_api_base", "minimaxApiBase"]),
        minimaxModel: readStringField(body, ["minimax_model", "minimaxModel"]),
        minimaxSessionDir: readStringField(body, ["minimax_session_dir", "minimaxSessionDir"]),
        minimaxMcpServers: body.minimax_mcp_servers ?? body.minimaxMcpServers as any,
        minimaxMaxSteps: typeof body.minimax_max_steps === 'number' ? body.minimax_max_steps : typeof body.minimaxMaxSteps === 'number' ? body.minimaxMaxSteps : undefined,
        minimaxTokenLimit: typeof body.minimax_token_limit === 'number' ? body.minimax_token_limit : typeof body.minimaxTokenLimit === 'number' ? body.minimaxTokenLimit : undefined
      });
      res.status(200).json({
        codexCliCommand: updated.codexCliCommand,
        traeCliCommand: updated.traeCliCommand,
        minimaxApiKey: updated.minimaxApiKey,
        minimaxApiBase: updated.minimaxApiBase,
        minimaxModel: updated.minimaxModel,
        minimaxSessionDir: updated.minimaxSessionDir,
        minimaxMcpServers: updated.minimaxMcpServers,
        minimaxMaxSteps: updated.minimaxMaxSteps,
        minimaxTokenLimit: updated.minimaxTokenLimit,
        updatedAt: updated.updatedAt
      });
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/agents", async (_req, res, next) => {
    try {
      const custom = await listAgents(dataRoot);
      res.status(200).json({ items: custom, total: custom.length });
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
        taskAssignRouteTable: (body.task_assign_route_table ?? body.taskAssignRouteTable) as Record<string, string[]> | undefined,
        routeDiscussRounds: (body.route_discuss_rounds ?? body.routeDiscussRounds) as Record<string, Record<string, number>> | undefined,
        agentModelConfigs: (body.agent_model_configs ?? body.agentModelConfigs) as Record<string, { tool: "codex" | "trae" | "minimax"; model: string; effort?: "low" | "medium" | "high" }> | undefined,
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
        taskAssignRouteTable: (body.task_assign_route_table ?? body.taskAssignRouteTable) as Record<string, string[]> | undefined,
        routeDiscussRounds: (body.route_discuss_rounds ?? body.routeDiscussRounds) as Record<string, Record<string, number>> | undefined,
        agentModelConfigs: (body.agent_model_configs ?? body.agentModelConfigs) as Record<string, { tool: "codex" | "trae" | "minimax"; model: string; effort?: "low" | "medium" | "high" }> | undefined,
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

  app.get("/api/orchestrator/status", async (_req, res, next) => {
    try {
      const status = await orchestrator.getStatus();
      res.json(status);
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
      const defaultCliTool = (body.default_cli_tool ?? body.defaultCliTool) as string | undefined;
      const defaultModelParams = (body.default_model_params ?? body.defaultModelParams) as Record<string, any> | undefined;
      const modelSelectionEnabled = (body.model_selection_enabled ?? body.modelSelectionEnabled) as boolean | undefined;
      if (!agentId || !prompt) {
        res.status(400).json({ error: "agent_id and prompt are required" });
        return;
      }
      const created = await createAgent(dataRoot, {
        agentId,
        displayName,
        prompt,
        defaultCliTool: defaultCliTool === "trae" ? "trae" : defaultCliTool === "minimax" ? "minimax" : defaultCliTool === "codex" ? "codex" : undefined,
        defaultModelParams,
        modelSelectionEnabled
      });
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/agents/:agent_id", async (req, res, next) => {
    try {
      const agentId = req.params.agent_id;
      const body = req.body as Record<string, unknown>;
      const updated = await patchAgent(dataRoot, agentId, {
        displayName: (body.display_name ?? body.displayName) as string | undefined,
        prompt: body.prompt as string | undefined,
        defaultCliTool: (body.default_cli_tool ?? body.defaultCliTool) as "codex" | "trae" | "minimax" | undefined,
        defaultModelParams: (body.default_model_params ?? body.defaultModelParams) as Record<string, any> | undefined,
        modelSelectionEnabled: (body.model_selection_enabled ?? body.modelSelectionEnabled) as boolean | undefined
      });
      res.status(200).json(updated);
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
      let teamAgentModelConfigs: Record<string, { tool: "codex" | "trae" | "minimax"; model: string; effort?: "low" | "medium" | "high" }> | undefined;
      
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
      const routeTable = (body.route_table ?? body.routeTable) as Record<string, string[]> | undefined ?? teamRouteTable;
      const taskAssignRouteTable = (body.task_assign_route_table ?? body.taskAssignRouteTable) as Record<string, string[]> | undefined ?? teamTaskAssignRouteTable;
      const routeDiscussRounds = (body.route_discuss_rounds ?? body.routeDiscussRounds) as
        | Record<string, Record<string, number>>
        | undefined ?? teamRouteDiscussRounds;
      const agentModelConfigs = (body.agent_model_configs ?? body.agentModelConfigs) as
        | Record<string, { tool: "codex" | "trae" | "minimax"; model: string; effort?: "low" | "medium" | "high" }>
        | undefined ?? teamAgentModelConfigs;
      const autoDispatchEnabled = parseBoolean(body.auto_dispatch_enabled ?? body.autoDispatchEnabled, true);
      const autoDispatchRemaining = parseInteger(body.auto_dispatch_remaining ?? body.autoDispatchRemaining) ?? 5;
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
      const agentWorkspaceBootstrap = await ensureAgentWorkspaces(created.project, agentPrompts);

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
        payload: { createdFiles: agentWorkspaceBootstrap.createdFiles, skippedFiles: agentWorkspaceBootstrap.skippedFiles }
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
      const snapshot = buildProjectRoutingSnapshot(project, fromAgentTrim, registry.map((item) => item.agentId));
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
      const agentModelConfigs = (body.agent_model_configs ?? body.agentModelConfigs) as
        | Record<string, { tool: string; model: string; effort?: string }>
        | undefined;
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
      const hasEnabled = typeof enabledRaw === "boolean";
      const remainingParsed = parseInteger(remainingRaw);
      const hasRemaining = remainingRaw !== undefined;
      if (!hasEnabled && !hasRemaining) {
        res.status(400).json({
          code: "ORCHESTRATOR_SETTINGS_INVALID",
          error: "at least one of auto_dispatch_enabled or auto_dispatch_remaining is required"
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
        autoDispatchRemaining: hasRemaining ? remainingParsed : undefined
      });
      res.status(200).json({
        project_id: updated.projectId,
        auto_dispatch_enabled: updated.autoDispatchEnabled ?? true,
        auto_dispatch_remaining: updated.autoDispatchRemaining ?? 5,
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

  app.get("/api/models", async (req, res, next) => {
    try {
      const projectId = typeof req.query.project_id === "string" ? req.query.project_id.trim() : "";
      const refresh = typeof req.query.refresh === "string" && req.query.refresh === "true";
      
      if (!projectId) {
        const defaultModels = [
          { vendor: "codex", model: "gpt-5.3-codex", description: "Codex recommended model" },
          { vendor: "codex", model: "gpt-5", description: "GPT-5 model" },
          { vendor: "trae", model: "trae-1", description: "Trae 1 model" },
          { vendor: "minimax", model: "MiniMax-M2.5", description: "MiniMax M2.5 model" },
          { vendor: "minimax", model: "MiniMax-M2", description: "MiniMax M2 model" },
          { vendor: "minimax", model: "abab6.5-chat", description: "MiniMax abab6.5 chat model" },
          { vendor: "minimax", model: "abab6.5s-chat", description: "MiniMax abab6.5s chat model" },
          { vendor: "minimax", model: "abab6-chat", description: "MiniMax abab6 chat model" }
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

  app.post("/api/projects/:id/sessions", async (req, res, next) => {
    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const body = req.body as Record<string, unknown>;
      const role = (body.role ?? body.to_role) as string | undefined;
      const status = body.status as string | undefined;
      const currentTaskId = (body.current_task_id ?? body.currentTaskId) as string | undefined;
      const requestedSessionKey = readStringField(body, ["session_id", "sessionId"]);
      if (!role) {
        res.status(400).json({ error: "role is required" });
        return;
      }
      const configuredTool = project.agentModelConfigs?.[role]?.tool;
      if (configuredTool && configuredTool !== "codex" && configuredTool !== "trae" && configuredTool !== "minimax") {
        sendApiError(
          res,
          409,
          "SESSION_PROVIDER_NOT_SUPPORTED",
          `role '${role}' is configured with unsupported tool '${configuredTool}'`,
          "Only codex, trae, and minimax providers are supported for session startup."
        );
        return;
      }
      const existing = await resolveLatestSessionByRole(paths, project.projectId, role);
      if (existing && existing.status !== "dismissed") {
        sendApiError(
          res,
          409,
          "SESSION_ROLE_CONFLICT",
          `role '${role}' already has active session '${existing.sessionId}'`,
          "Dismiss/repair the existing role session before creating a new one."
        );
        return;
      }
      const pendingSessionId = buildPendingSessionId(role);
      const roleAgentTool = project.agentModelConfigs?.[role]?.tool ?? "codex";
      const created = await addSession(paths, project.projectId, {
        sessionId: pendingSessionId,
        sessionKey: requestedSessionKey ?? pendingSessionId,
        role,
        status,
        currentTaskId,
        provider: "codex",
        providerSessionId: undefined,
        agentTool: roleAgentTool as "codex" | "trae" | "minimax"
      });
      const mappingError = validateRoleSessionMapWrite(created.session.role, created.session.sessionId);
      if (!mappingError) {
        await setRoleSessionMapping(dataRoot, project.projectId, created.session.role, created.session.sessionId);
      }
      res.status(created.created ? 201 : 200).json({
        ...created,
        status: "pending",
        sessionKey: created.session.sessionKey ?? created.session.sessionId
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:id/sessions", async (req, res, next) => {
    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const [sessions, locks] = await Promise.all([listSessions(paths, project.projectId), listActiveLocks(paths)]);
      const roleMap = new Map<string, typeof sessions[number]>();
      for (const session of sessions) {
        const existing = roleMap.get(session.role);
        if (!existing || Date.parse(session.lastActiveAt) > Date.parse(existing.lastActiveAt)) {
          roleMap.set(session.role, session);
        }
      }
      const items = Array.from(roleMap.values())
        .map((session) => {
          const isPending = !session.providerSessionId;
          return {
            ...session,
            sessionId: isPending ? null : session.sessionId,
            sessionKey: session.sessionKey ?? (isPending ? session.sessionId : null),
            providerSessionId: session.providerSessionId ?? null,
            provider: "codex",
            locksHeldCount: locks.filter((lock) => lock.ownerSessionId === session.sessionId).length
          };
        })
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
      const session = await resolveSessionByIdOrKey(paths, project.projectId, token);
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
      res.status(200).json({ session: dismissed, mappingCleared, processTermination });
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
      const session = await resolveSessionByIdOrKey(paths, project.projectId, token);
      if (!session) {
        sendApiError(res, 404, "SESSION_NOT_FOUND", `session '${token}' not found`);
        return;
      }
      const repaired = await orchestrator.repairSessionStatus(req.params.id, session.sessionId, targetStatus);
      res.status(200).json(repaired);
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
      const token = req.params.role;
      const resolvedSession = await resolveSessionByIdOrKey(paths, project.projectId, token);
      const targetRole = resolvedSession?.role ?? token;
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
    logger.info(`[API] POST /api/projects/${projectId}/messages/send - message_type=${messageType}, from_agent=${fromAgent} - request received`);
    
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
    logger.info(`[API] POST /api/projects/${projectId}/task-actions - request received, body=${JSON.stringify(requestBody)}`);
    
    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const result = await handleTaskAction(dataRoot, project, paths, requestBody);
      const duration = Date.now() - startTime;
      logger.info(`[API] POST /api/projects/${projectId}/task-actions - completed in ${duration}ms, result=${JSON.stringify(result)}`);
      res.status(201).json(result);
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`[API] POST /api/projects/${projectId}/task-actions - error after ${duration}ms: ${error}, body=${JSON.stringify(requestBody)}`);
      if (error instanceof TaskActionError) {
        const nextAction = resolveTaskActionNextAction(error.code);
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
      if (!resolvedSessionId && role) {
        const latest = await resolveLatestSessionByRole(paths, project.projectId, role);
        resolvedSessionId = latest?.sessionId;
      }
      const result = await orchestrator.dispatchProject(req.params.id, {
        mode: "manual",
        sessionId: resolvedSessionId,
        taskId: (body.task_id ?? body.taskId) as string | undefined,
        force: Boolean(body.force ?? false),
        onlyIdle: body.only_idle === undefined && body.onlyIdle === undefined ? false : Boolean(body.only_idle ?? body.onlyIdle)
      });
      const dispatchedCount = result.results.filter((item) => item.outcome === "dispatched").length;
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
        onlyIdle: body.only_idle === undefined && body.onlyIdle === undefined ? false : Boolean(body.only_idle ?? body.onlyIdle)
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
      const maxDepthRaw = typeof req.query.max_descendant_depth === "string" ? Number(req.query.max_descendant_depth) : undefined;
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
      const patch: import("./data/taskboard-store.js").TaskPatchInput = {};
      if (Object.prototype.hasOwnProperty.call(body, "title")) {
        patch.title = typeof body.title === "string" ? body.title.trim() || undefined : undefined;
      }
      if (Object.prototype.hasOwnProperty.call(body, "state")) {
        patch.state = typeof body.state === "string" ? body.state as import("./domain/models.js").TaskState : undefined;
      }
      if (Object.prototype.hasOwnProperty.call(body, "owner_role") || Object.prototype.hasOwnProperty.call(body, "ownerRole")) {
        patch.ownerRole = typeof (body.owner_role ?? body.ownerRole) === "string" 
          ? (body.owner_role ?? body.ownerRole) as string 
          : undefined;
      }
      if (Object.prototype.hasOwnProperty.call(body, "dependencies")) {
        patch.dependencies = Array.isArray(body.dependencies)
          ? body.dependencies.map((d) => String(d).trim()).filter((d) => d)
          : undefined;
      }
      if (Object.prototype.hasOwnProperty.call(body, "write_set") || Object.prototype.hasOwnProperty.call(body, "writeSet")) {
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
      const { patchTask, recomputeRunnableStates } = await import("./data/taskboard-store.js");
      const { appendEvent } = await import("./data/event-store.js");
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
    logger.info(`[API] POST /api/projects/${projectId}/locks/acquire - session_id=${sessionId}, lock_key=${lockKey} - request received`);
    
    try {
      const project = await getProject(dataRoot, req.params.id);
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
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
      const acquired = await acquireLock(paths, { projectId: project.projectId, sessionId, lockKey, targetType, ttlSeconds, purpose });
      if (acquired.kind === "acquired") {
        const duration = Date.now() - startTime;
        logger.info(`[API] POST /api/projects/${projectId}/locks/acquire - completed in ${duration}ms, result=acquired`);
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
    logger.info(`[API] POST /api/projects/${projectId}/locks/renew - session_id=${sessionId}, lock_key=${lockKey} - request received`);
    
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
      const renewed = await renewLock(paths, { sessionId, lockKey });
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
    logger.info(`[API] POST /api/projects/${projectId}/locks/release - session_id=${sessionId}, lock_key=${lockKey} - request received`);
    
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
      const released = await releaseLock(paths, { sessionId, lockKey });
      if (released.kind === "released") {
        const duration = Date.now() - startTime;
        logger.info(`[API] POST /api/projects/${projectId}/locks/release - completed in ${duration}ms, result=released`);
        res.status(200).json({ result: "released", lock: released.lock });
        return;
      }
      if (released.kind === "not_found") {
        const duration = Date.now() - startTime;
        logger.info(`[API] POST /api/projects/${projectId}/locks/release - completed in ${duration}ms, result=not_found`);
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
      const paths = await ensureProjectRuntime(dataRoot, project.projectId);
      const items = await listActiveLocks(paths);
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
      const fs = await import("node:fs/promises");
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

  // ========================================
  // Agent Chat API - Direct agent communication (SSE Streaming)
  // ========================================

  // POST /api/projects/:id/agent-chat - Send message to agent (SSE streaming)
  app.post("/api/projects/:id/agent-chat", async (req, res, next) => {
    const projectId = req.params.id;
    const body = req.body as Record<string, unknown>;
    const role = (body.role as string)?.trim();
    const prompt = (body.prompt as string)?.trim();
    const sessionId = (body.sessionId as string)?.trim();
    const providerSessionId = (body.providerSessionId as string)?.trim();

    logger.info(`[API] POST /api/projects/${projectId}/agent-chat - role=${role}, sessionId=${sessionId}, providerSessionId=${providerSessionId} - request received`);

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

      if (!settings.minimaxApiKey) {
        sendEvent("error", { message: "MiniMax API key is not configured. Please configure it in Settings." });
        res.end();
        return;
      }

      // Use the sessionId from request if provided, otherwise create new one
      const chatSessionId = sessionId || `agent-chat-${Date.now()}-${randomUUID().slice(0, 8)}`;
      // Use agent's personal workspace: <project-workspace>/Agents/<role>/
      const agentWorkspaceDir = path.join(project.workspacePath, "Agents", role);

      sendEvent("session", { sessionId: chatSessionId, providerSessionId });

      const agent = createMiniMaxAgent({
        config: {
          apiKey: settings.minimaxApiKey ?? "",
          apiBase: settings.minimaxApiBase ?? "https://api.minimax.io/v1",
          model: settings.minimaxModel ?? "MiniMax-Text-01",
          workspaceDir: agentWorkspaceDir,
          sessionDir: settings.minimaxSessionDir ?? path.join(paths.projectRootDir, ".minimax", "sessions"),
          maxSteps: settings.minimaxMaxSteps ?? 200,
          tokenLimit: settings.minimaxTokenLimit ?? 180000,
          enableFileTools: true,
          enableShell: true,
          enableNote: true,
          shellType: "powershell",
          shellTimeout: settings.minimaxShellTimeout ?? 30000,
          shellOutputIdleTimeout: settings.minimaxShellOutputIdleTimeout ?? 60000,
          shellMaxRunTime: settings.minimaxShellMaxRunTime ?? 600000,
          shellMaxOutputSize: settings.minimaxShellMaxOutputSize ?? 52428800,
          mcpEnabled: (settings.minimaxMcpServers?.length ?? 0) > 0,
          mcpServers: settings.minimaxMcpServers ?? [],
          mcpConnectTimeout: 30000,
          mcpExecuteTimeout: 60000,
          additionalWritableDirs: [project.workspacePath],
          env: {
            AUTO_DEV_PROJECT_ID: projectId,
            AUTO_DEV_SESSION_ID: chatSessionId,
            AUTO_DEV_AGENT_ROLE: role,
            AUTO_DEV_PROJECT_ROOT: project.workspacePath,
            AUTO_DEV_AGENT_WORKSPACE: agentWorkspaceDir,
            AUTO_DEV_MANAGER_URL: process.env.AUTO_DEV_MANAGER_URL ?? "http://127.0.0.1:3000",
          },
        },
      });

      // Run with streaming callbacks - pass providerSessionId as sessionId to use existing context
      await agent.runWithResult({
        prompt,
        sessionId: providerSessionId || chatSessionId,
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
          onComplete: (result: string, finishReason?: string) => {
            sendEvent("complete", { result, finishReason });
          },
        },
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
    const sessionId = req.params.sessionId;

    logger.info(`[API] POST /api/projects/${req.params.id}/agent-chat/${sessionId}/interrupt - request received`);

    try {
      const cancelled = cancelMiniMaxRunner(sessionId);
      const duration = Date.now() - startTime;
      logger.info(`[API] POST /api/projects/${req.params.id}/agent-chat/${sessionId}/interrupt - completed in ${duration}ms, cancelled=${cancelled}`);

      res.json({ success: true, cancelled });
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`[API] POST /api/projects/${req.params.id}/agent-chat/${sessionId}/interrupt - error after ${duration}ms: ${error}`);
      next(error);
    }
  });

  return app;
}
