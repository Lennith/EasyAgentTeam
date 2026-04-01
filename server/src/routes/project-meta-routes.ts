import type express from "express";
import type { ProviderId } from "@autodev/agent-library";
import { listAgents } from "../data/agent-store.js";
import { appendEvent } from "../data/event-store.js";
import {
  deleteProject,
  ensureProjectRuntime,
  getProject,
  getProjectOverview,
  listProjects,
  ProjectStoreError,
  updateProjectOrchestratorSettings,
  updateProjectRouting,
  updateTaskAssignRouting
} from "../data/project-store.js";
import { getTeam } from "../data/team-store.js";
import { buildProjectRoutingSnapshot } from "../services/project-routing-snapshot-service.js";
import { createProjectWithAudit } from "../services/project-meta-use-cases.js";
import { logger } from "../utils/logger.js";
import type { AppRuntimeContext } from "./shared/context.js";
import { parseBoolean, parseInteger, parseReminderMode, readAgentModelConfigsField } from "./shared/http.js";

export function registerProjectMetaRoutes(app: express.Application, context: AppRuntimeContext): void {
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

      const created = await createProjectWithAudit(dataRoot, {
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
        await updateTaskAssignRouting(dataRoot, created.projectId, taskAssignRouteTable);
      }

      if (agentModelConfigs && Object.keys(agentModelConfigs).length > 0) {
        await updateProjectRouting(dataRoot, created.projectId, {
          agentIds: created.agentIds ?? [],
          routeTable: created.routeTable ?? {},
          agentModelConfigs
        });
      }

      res.status(201).json(created);
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
