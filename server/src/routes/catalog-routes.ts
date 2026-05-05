import type express from "express";
import {
  CatalogAgentCreateRequestSchema,
  CatalogAgentPatchRequestSchema,
  CatalogAgentTemplateCreateRequestSchema,
  CatalogAgentTemplatePatchRequestSchema,
  CatalogSkillImportRequestSchema,
  CatalogSkillListCreateRequestSchema,
  CatalogSkillListPatchRequestSchema,
  CatalogTeamCreateRequestSchema,
  CatalogTeamUpdateRequestSchema
} from "@autodev/agent-library";
import { getBuiltInAgents } from "../services/agent-prompt-service.js";
import {
  createCatalogAgent,
  createCatalogAgentTemplate,
  createCatalogSkillList,
  createCatalogTeam,
  deleteCatalogAgent,
  deleteCatalogAgentTemplate,
  deleteCatalogSkill,
  deleteCatalogSkillList,
  deleteCatalogTeam,
  importCatalogSkills,
  listCatalogAgentTemplates,
  listCatalogAgents,
  listCatalogSkillLists,
  listCatalogSkills,
  listCatalogTeams,
  patchCatalogAgent,
  patchCatalogAgentTemplate,
  patchCatalogSkillList,
  readCatalogTeam,
  updateCatalogTeam,
  validateCatalogSkillListIds
} from "../services/catalog-admin-service.js";
import type { AppRuntimeContext } from "./shared/context.js";
import {
  hasUnsupportedAgentModelConfigs,
  isUnsupportedProviderId,
  readAgentModelConfigsField,
  validateAgentModelConfigsForApi,
  validateAgentModelParamsForApi,
  sendApiError
} from "./shared/http.js";

export function registerCatalogRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot } = context;
  app.get("/api/agents", async (_req, res, next) => {
    try {
      const custom = await listCatalogAgents(dataRoot);
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
      const customItems = (await listCatalogAgentTemplates(dataRoot)).map((item) => ({
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
      const parsed = CatalogAgentTemplateCreateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendApiError(res, 400, "AGENT_TEMPLATE_INPUT_INVALID", "template_id and prompt are required");
        return;
      }
      const created = await createCatalogAgentTemplate(dataRoot, {
        templateId: parsed.data.templateId,
        displayName: parsed.data.displayName,
        prompt: parsed.data.prompt,
        basedOnTemplateId: parsed.data.basedOnTemplateId
      });
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/agent-templates/:template_id", async (req, res, next) => {
    try {
      const templateId = req.params.template_id;
      const parsed = CatalogAgentTemplatePatchRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendApiError(res, 400, "AGENT_TEMPLATE_INPUT_INVALID", "template patch payload is invalid");
        return;
      }
      const updated = await patchCatalogAgentTemplate(dataRoot, templateId, {
        displayName: parsed.data.displayName,
        prompt: parsed.data.prompt,
        basedOnTemplateId: parsed.data.basedOnTemplateId
      });
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/agent-templates/:template_id", async (req, res, next) => {
    try {
      const removed = await deleteCatalogAgentTemplate(dataRoot, req.params.template_id);
      res.status(200).json(removed);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/teams", async (_req, res, next) => {
    try {
      const teams = await listCatalogTeams(dataRoot);
      res.status(200).json({ items: teams, total: teams.length });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/teams/:teamId", async (req, res, next) => {
    try {
      const team = await readCatalogTeam(dataRoot, req.params.teamId);
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
      const parsed = CatalogTeamCreateRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(
          res,
          400,
          "TEAM_INPUT_INVALID",
          "team_id is required and provider_id must be codex, minimax, or dpagent"
        );
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
      const created = await createCatalogTeam(dataRoot, {
        teamId: parsed.data.teamId,
        name: parsed.data.name,
        description: parsed.data.description,
        agentIds: parsed.data.agentIds,
        routeTable: parsed.data.routeTable,
        taskAssignRouteTable: parsed.data.taskAssignRouteTable,
        routeDiscussRounds: parsed.data.routeDiscussRounds,
        agentModelConfigs
      });
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/teams/:teamId", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const parsed = CatalogTeamUpdateRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(res, 400, "TEAM_INPUT_INVALID", "team payload is invalid");
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
      const updated = await updateCatalogTeam(dataRoot, req.params.teamId, {
        name: parsed.data.name,
        description: parsed.data.description,
        agentIds: parsed.data.agentIds,
        routeTable: parsed.data.routeTable,
        taskAssignRouteTable: parsed.data.taskAssignRouteTable,
        routeDiscussRounds: parsed.data.routeDiscussRounds,
        agentModelConfigs
      });
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/teams/:teamId", async (req, res, next) => {
    try {
      const removed = await deleteCatalogTeam(dataRoot, req.params.teamId);
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
      const parsed = CatalogAgentCreateRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(
          res,
          400,
          "AGENT_INPUT_INVALID",
          "agent_id and prompt are required; provider_id must be codex, minimax, or dpagent"
        );
        return;
      }
      const agentId = parsed.data.agentId;
      const displayName = parsed.data.displayName;
      const prompt = parsed.data.prompt;
      const summary = parsed.data.summary;
      const defaultProviderId = parsed.data.providerId;
      if (isUnsupportedProviderId(defaultProviderId)) {
        sendApiError(res, 400, "PROVIDER_NOT_SUPPORTED", "provider_id must be codex, minimax, or dpagent");
        return;
      }
      const defaultModelParams = parsed.data.defaultModelParams as Record<string, any> | undefined;
      const normalizedProviderId =
        defaultProviderId !== undefined || defaultModelParams ? (defaultProviderId ?? "minimax") : undefined;
      const modelValidation = validateAgentModelParamsForApi(normalizedProviderId, defaultModelParams);
      if (modelValidation) {
        sendApiError(res, 400, "AGENT_MODEL_PROVIDER_MISMATCH", modelValidation.message, modelValidation.nextAction);
        return;
      }
      const modelSelectionEnabled = parsed.data.modelSelectionEnabled;
      const skillList = parsed.data.skillList;
      if (skillList && skillList.length > 0) {
        const missing = await validateCatalogSkillListIds(dataRoot, skillList);
        if (missing.length > 0) {
          sendApiError(res, 400, "AGENT_SKILL_LIST_INVALID", `unknown skill lists: ${missing.join(", ")}`);
          return;
        }
      }
      const created = await createCatalogAgent(dataRoot, {
        agentId,
        displayName,
        prompt,
        summary,
        skillList,
        defaultCliTool: normalizedProviderId,
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
      const parsed = CatalogAgentPatchRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(res, 400, "AGENT_INPUT_INVALID", "agent patch payload is invalid");
        return;
      }
      if (Object.prototype.hasOwnProperty.call(body, "provider_id") && isUnsupportedProviderId(body.provider_id)) {
        sendApiError(res, 400, "PROVIDER_NOT_SUPPORTED", "provider_id must be codex, minimax, or dpagent");
        return;
      }
      const skillListPatch = parsed.data.skillList;
      if (skillListPatch && skillListPatch.length > 0) {
        const missing = await validateCatalogSkillListIds(dataRoot, skillListPatch);
        if (missing.length > 0) {
          sendApiError(res, 400, "AGENT_SKILL_LIST_INVALID", `unknown skill lists: ${missing.join(", ")}`);
          return;
        }
      }
      const existingAgents = await listCatalogAgents(dataRoot);
      const existingAgent = existingAgents.find((item) => item.agentId === agentId);
      const defaultModelParams = parsed.data.defaultModelParams as Record<string, any> | undefined;
      const normalizedProviderId =
        parsed.data.providerId !== undefined
          ? parsed.data.providerId
          : defaultModelParams
            ? (existingAgent?.defaultCliTool ?? "minimax")
            : existingAgent?.defaultCliTool;
      const modelValidation = validateAgentModelParamsForApi(normalizedProviderId, defaultModelParams);
      if (modelValidation) {
        sendApiError(res, 400, "AGENT_MODEL_PROVIDER_MISMATCH", modelValidation.message, modelValidation.nextAction);
        return;
      }
      const updated = await patchCatalogAgent(dataRoot, agentId, {
        displayName: parsed.data.displayName,
        prompt: parsed.data.prompt,
        summary: parsed.data.summary,
        skillList: skillListPatch,
        defaultCliTool: parsed.data.providerId !== undefined ? normalizedProviderId : undefined,
        defaultModelParams,
        modelSelectionEnabled: parsed.data.modelSelectionEnabled
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
      const removed = await deleteCatalogAgent(dataRoot, req.params.agent_id);
      res.status(200).json(removed);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/skills", async (_req, res, next) => {
    try {
      const items = await listCatalogSkills(dataRoot);
      res.status(200).json({ items, total: items.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/skills/import", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const parsed = CatalogSkillImportRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(res, 400, "SKILL_IMPORT_INPUT_INVALID", "sources is required");
        return;
      }
      const result = await importCatalogSkills(dataRoot, parsed.data);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/skills/:skill_id", async (req, res, next) => {
    try {
      const removed = await deleteCatalogSkill(dataRoot, req.params.skill_id);
      res.status(200).json(removed);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/skill-lists", async (_req, res, next) => {
    try {
      const items = await listCatalogSkillLists(dataRoot);
      res.status(200).json({ items, total: items.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/skill-lists", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const parsed = CatalogSkillListCreateRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(res, 400, "SKILL_LIST_INPUT_INVALID", "list_id is required");
        return;
      }
      const created = await createCatalogSkillList(dataRoot, {
        listId: parsed.data.listId,
        displayName: parsed.data.displayName,
        description: parsed.data.description,
        includeAll: parsed.data.includeAll,
        skillIds: parsed.data.skillIds
      });
      res.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/skill-lists/:list_id", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const parsed = CatalogSkillListPatchRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(res, 400, "SKILL_LIST_INPUT_INVALID", "skill list patch payload is invalid");
        return;
      }
      const updated = await patchCatalogSkillList(dataRoot, req.params.list_id, {
        displayName: parsed.data.displayName,
        description: parsed.data.description,
        includeAll: parsed.data.hasIncludeAll ? Boolean(parsed.data.includeAll) : undefined,
        skillIds: parsed.data.hasSkillIds ? (parsed.data.skillIds ?? []) : undefined
      });
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/skill-lists/:list_id", async (req, res, next) => {
    try {
      const listId = req.params.list_id;
      const agents = await listCatalogAgents(dataRoot);
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
      const removed = await deleteCatalogSkillList(dataRoot, listId);
      res.status(200).json(removed);
    } catch (error) {
      next(error);
    }
  });
}
