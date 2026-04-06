import type express from "express";
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
  parseBoolean,
  readAgentModelConfigsField,
  readNullableStringPatch,
  readProviderIdField,
  readStringArray,
  readStringField,
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
      const body = req.body as Record<string, unknown>;
      const created = await createCatalogAgentTemplate(dataRoot, {
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
      const updated = await patchCatalogAgentTemplate(dataRoot, templateId, {
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
      const created = await createCatalogTeam(dataRoot, {
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
      const updated = await updateCatalogTeam(dataRoot, req.params.teamId, {
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
        const missing = await validateCatalogSkillListIds(dataRoot, skillListPatch);
        if (missing.length > 0) {
          sendApiError(res, 400, "AGENT_SKILL_LIST_INVALID", `unknown skill lists: ${missing.join(", ")}`);
          return;
        }
      }
      const updated = await patchCatalogAgent(dataRoot, agentId, {
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
      const result = await importCatalogSkills(dataRoot, { sources, recursive });
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
      const listId = readStringField(body, ["list_id", "listId"]);
      if (!listId) {
        sendApiError(res, 400, "SKILL_LIST_INPUT_INVALID", "list_id is required");
        return;
      }
      const created = await createCatalogSkillList(dataRoot, {
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
      const updated = await patchCatalogSkillList(dataRoot, req.params.list_id, {
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
