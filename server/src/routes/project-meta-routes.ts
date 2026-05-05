import type express from "express";
import {
  ProjectCreateRequestSchema,
  ProjectOrchestratorSettingsPatchRequestSchema,
  ProjectRoutingConfigRequestSchema,
  ProjectTaskAssignRoutingRequestSchema
} from "@autodev/agent-library";
import { buildProjectRoutingSnapshot } from "../services/project-routing-snapshot-service.js";
import {
  appendProjectAuditEvent,
  deleteProjectById,
  listProjectSummaries,
  listRegisteredAgents,
  readProject,
  readProjectOverview,
  readTeamDefinition,
  updateProjectOrchestratorConfig,
  updateProjectRoutingConfig,
  updateProjectTaskAssignRouting
} from "../services/project-admin-service.js";
import { createProjectWithAudit } from "../services/project-meta-use-cases.js";
import { logger } from "../utils/logger.js";
import type { AppRuntimeContext } from "./shared/context.js";
import {
  hasUnsupportedAgentModelConfigs,
  readAgentModelConfigsField,
  validateAgentModelConfigsForApi,
  sendApiError
} from "./shared/http.js";

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
      const parsed = ProjectCreateRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(res, 400, "PROJECT_INPUT_INVALID", "project_id, name, workspace_path are required");
        return;
      }
      const projectId = parsed.data.projectId;
      const name = parsed.data.name;
      const workspacePath = parsed.data.workspacePath;
      const templateId = parsed.data.templateId;
      const teamId = parsed.data.teamId;

      let teamAgentIds: string[] | undefined;
      let teamRouteTable: Record<string, string[]> | undefined;
      let teamTaskAssignRouteTable: Record<string, string[]> | undefined;
      let teamRouteDiscussRounds: Record<string, Record<string, number>> | undefined;
      let teamAgentModelConfigs: NonNullable<typeof parsed.data.agentModelConfigs> | undefined;

      if (teamId) {
        const team = await readTeamDefinition(dataRoot, teamId);
        if (team) {
          teamAgentIds = team.agentIds;
          teamRouteTable = team.routeTable;
          teamTaskAssignRouteTable = team.taskAssignRouteTable;
          teamRouteDiscussRounds = team.routeDiscussRounds;
          teamAgentModelConfigs = team.agentModelConfigs;
        }
      }

      const agentIds = parsed.data.agentIds ?? teamAgentIds;
      const routeTable = parsed.data.routeTable ?? teamRouteTable;
      const taskAssignRouteTable = parsed.data.taskAssignRouteTable ?? teamTaskAssignRouteTable;
      const routeDiscussRounds = parsed.data.routeDiscussRounds ?? teamRouteDiscussRounds;
      const agentModelConfigs = parsed.data.agentModelConfigs ?? teamAgentModelConfigs;
      const modelValidation = validateAgentModelConfigsForApi(agentModelConfigs);
      if (modelValidation) {
        sendApiError(res, 400, "AGENT_MODEL_PROVIDER_MISMATCH", modelValidation.message, modelValidation.nextAction);
        return;
      }
      const autoDispatchEnabled = parsed.data.autoDispatchEnabled;
      const autoDispatchRemaining = parsed.data.autoDispatchRemaining;
      const holdEnabled = parsed.data.holdEnabled;
      const reminderMode = parsed.data.reminderMode;
      if (hasUnsupportedAgentModelConfigs(body.agent_model_configs ?? body.agentModelConfigs)) {
        sendApiError(res, 400, "PROVIDER_NOT_SUPPORTED", "provider_id must be codex, minimax, or dpagent");
        return;
      }
      const roleSessionMap = parsed.data.roleSessionMap;

      const normalizedAgentIds = Array.isArray(agentIds)
        ? Array.from(new Set(agentIds.map((item) => String(item).trim()).filter((item) => item.length > 0)))
        : [];
      if (normalizedAgentIds.length > 0) {
        const registry = await listRegisteredAgents(dataRoot);
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
        await updateProjectTaskAssignRouting(dataRoot, created.projectId, taskAssignRouteTable);
      }

      if (agentModelConfigs && Object.keys(agentModelConfigs).length > 0) {
        await updateProjectRoutingConfig(dataRoot, created.projectId, {
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
      const items = await listProjectSummaries(dataRoot);
      res.json({ items, total: items.length });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:id", async (req, res, next) => {
    try {
      const project = await readProjectOverview(dataRoot, req.params.id);
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
      const project = await readProject(dataRoot, req.params.id);
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
      const project = await readProject(dataRoot, req.params.id);
      const registry = await listRegisteredAgents(dataRoot);
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
      const project = await readProject(dataRoot, req.params.id);
      const parsed = ProjectRoutingConfigRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(res, 400, "PROJECT_ROUTING_INVALID", "agent_ids and route_table are required");
        return;
      }
      if (hasUnsupportedAgentModelConfigs(body.agent_model_configs ?? body.agentModelConfigs)) {
        sendApiError(res, 400, "PROVIDER_NOT_SUPPORTED", "provider_id must be codex, minimax, or dpagent");
        return;
      }
      const agentModelConfigs =
        parsed.data.agentModelConfigs ?? readAgentModelConfigsField(body.agent_model_configs ?? body.agentModelConfigs);
      const modelValidation = validateAgentModelConfigsForApi(agentModelConfigs);
      if (modelValidation) {
        sendApiError(res, 400, "AGENT_MODEL_PROVIDER_MISMATCH", modelValidation.message, modelValidation.nextAction);
        return;
      }
      const normalizedAgentIds = parsed.data.agentIds;
      const registry = await listRegisteredAgents(dataRoot);
      const known = new Set(registry.map((item) => item.agentId));
      const missing = normalizedAgentIds.filter((item) => !known.has(item));
      if (missing.length > 0) {
        res.status(400).json({ error: `agent_ids contain unregistered agents: ${missing.join(", ")}` });
        return;
      }

      const updated = await updateProjectRoutingConfig(dataRoot, project.projectId, {
        agentIds: normalizedAgentIds,
        routeTable: parsed.data.routeTable,
        routeDiscussRounds: parsed.data.routeDiscussRounds,
        agentModelConfigs
      });

      await appendProjectAuditEvent(dataRoot, project.projectId, {
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
      const parsed = ProjectTaskAssignRoutingRequestSchema.safeParse(body);
      if (!parsed.success) {
        res.status(400).json({
          code: "TASK_ASSIGN_ROUTING_INVALID",
          error: "task_assign_route_table is required and must be an object"
        });
        return;
      }
      const updated = await updateProjectTaskAssignRouting(dataRoot, req.params.id, parsed.data.taskAssignRouteTable);
      res.status(200).json({
        project_id: updated.projectId,
        task_assign_route_table: updated.taskAssignRouteTable ?? {},
        updated_at: updated.updatedAt
      });
    } catch (error) {
      if (error instanceof Error && error.constructor?.name === "ProjectStoreError") {
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
      const project = await readProject(dataRoot, req.params.id);
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
      const parsed = ProjectOrchestratorSettingsPatchRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(res, 400, "ORCHESTRATOR_SETTINGS_INVALID", "orchestrator settings payload is invalid");
        return;
      }
      if (
        !parsed.data.hasAutoDispatchEnabled &&
        !parsed.data.hasAutoDispatchRemaining &&
        !parsed.data.hasHoldEnabled &&
        !parsed.data.hasReminderMode
      ) {
        res.status(400).json({
          code: "ORCHESTRATOR_SETTINGS_INVALID",
          error:
            "at least one of auto_dispatch_enabled, auto_dispatch_remaining, hold_enabled, reminder_mode is required"
        });
        return;
      }
      if (
        parsed.data.hasAutoDispatchRemaining &&
        (parsed.data.autoDispatchRemaining === undefined ||
          parsed.data.autoDispatchRemaining < 0 ||
          parsed.data.autoDispatchRemaining > 1000)
      ) {
        res.status(400).json({
          code: "ORCHESTRATOR_SETTINGS_INVALID",
          error: "auto_dispatch_remaining must be integer in [0,1000]"
        });
        return;
      }
      const updated = await updateProjectOrchestratorConfig(dataRoot, req.params.id, {
        autoDispatchEnabled: parsed.data.hasAutoDispatchEnabled ? Boolean(parsed.data.autoDispatchEnabled) : undefined,
        autoDispatchRemaining: parsed.data.hasAutoDispatchRemaining ? parsed.data.autoDispatchRemaining : undefined,
        holdEnabled: parsed.data.hasHoldEnabled ? Boolean(parsed.data.holdEnabled) : undefined,
        reminderMode: parsed.data.hasReminderMode ? parsed.data.reminderMode : undefined
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
      const removed = await deleteProjectById(dataRoot, req.params.id, {
        orchestrator: context.orchestrator,
        providerRegistry: context.providerRegistry
      });
      res.status(200).json(removed);
    } catch (error) {
      next(error);
    }
  });
}
