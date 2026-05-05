import { z } from "zod";
import {
  dedupeStrings,
  firstString,
  nullableStringPatch,
  optionalString,
  ProviderIdSchema,
  requiredString,
  routeDiscussRounds,
  routeTable,
  stringArray,
  unknownRecord
} from "./common.js";
import { AgentModelConfigSchema } from "./project.js";

const AgentModelConfigMapSchema = z.record(z.string(), AgentModelConfigSchema).optional();

export const CatalogAgentTemplateCreateRequestSchema = z
  .object({
    template_id: optionalString,
    templateId: optionalString,
    display_name: optionalString,
    displayName: optionalString,
    prompt: requiredString,
    based_on_template_id: optionalString.nullable(),
    basedOnTemplateId: optionalString.nullable()
  })
  .transform((body, ctx) => {
    const templateId = firstString(body.template_id, body.templateId);
    if (!templateId) {
      ctx.addIssue({ code: "custom", path: ["template_id"], message: "template_id is required" });
      return z.NEVER;
    }
    return {
      templateId,
      displayName: firstString(body.display_name, body.displayName),
      prompt: body.prompt,
      basedOnTemplateId: body.based_on_template_id ?? body.basedOnTemplateId ?? undefined
    };
  });

export const CatalogAgentTemplatePatchRequestSchema = z
  .object({
    display_name: optionalString,
    displayName: optionalString,
    prompt: optionalString,
    based_on_template_id: optionalString.nullable(),
    basedOnTemplateId: optionalString.nullable()
  })
  .transform((body) => ({
    displayName: firstString(body.display_name, body.displayName),
    prompt: body.prompt,
    basedOnTemplateId:
      body.based_on_template_id === null || body.basedOnTemplateId === null
        ? null
        : firstString(body.based_on_template_id ?? undefined, body.basedOnTemplateId ?? undefined)
  }));

export const CatalogTeamCreateRequestSchema = z
  .object({
    team_id: optionalString,
    teamId: optionalString,
    name: optionalString,
    description: optionalString,
    agent_ids: stringArray,
    agentIds: stringArray,
    route_table: routeTable,
    routeTable,
    task_assign_route_table: routeTable,
    taskAssignRouteTable: routeTable,
    route_discuss_rounds: routeDiscussRounds,
    routeDiscussRounds: routeDiscussRounds,
    agent_model_configs: AgentModelConfigMapSchema,
    agentModelConfigs: AgentModelConfigMapSchema
  })
  .transform((body, ctx) => {
    const teamId = firstString(body.team_id, body.teamId);
    if (!teamId) {
      ctx.addIssue({ code: "custom", path: ["team_id"], message: "team_id is required" });
      return z.NEVER;
    }
    return {
      teamId,
      name: body.name ?? teamId,
      description: body.description,
      agentIds: dedupeStrings(body.agent_ids ?? body.agentIds),
      routeTable: body.route_table ?? body.routeTable,
      taskAssignRouteTable: body.task_assign_route_table ?? body.taskAssignRouteTable,
      routeDiscussRounds: body.route_discuss_rounds ?? body.routeDiscussRounds,
      agentModelConfigs: body.agent_model_configs ?? body.agentModelConfigs
    };
  });

export const CatalogTeamUpdateRequestSchema = z
  .object({
    name: optionalString,
    description: optionalString,
    agent_ids: stringArray,
    agentIds: stringArray,
    route_table: routeTable,
    routeTable,
    task_assign_route_table: routeTable,
    taskAssignRouteTable: routeTable,
    route_discuss_rounds: routeDiscussRounds,
    routeDiscussRounds: routeDiscussRounds,
    agent_model_configs: AgentModelConfigMapSchema,
    agentModelConfigs: AgentModelConfigMapSchema
  })
  .transform((body) => ({
    name: body.name,
    description: body.description,
    agentIds: dedupeStrings(body.agent_ids ?? body.agentIds),
    routeTable: body.route_table ?? body.routeTable,
    taskAssignRouteTable: body.task_assign_route_table ?? body.taskAssignRouteTable,
    routeDiscussRounds: body.route_discuss_rounds ?? body.routeDiscussRounds,
    agentModelConfigs: body.agent_model_configs ?? body.agentModelConfigs
  }));

export const CatalogAgentCreateRequestSchema = z
  .object({
    agent_id: optionalString,
    agentId: optionalString,
    display_name: optionalString,
    displayName: optionalString,
    prompt: requiredString,
    summary: optionalString,
    skill_list: stringArray.nullable(),
    skillList: stringArray.nullable(),
    provider_id: ProviderIdSchema.optional(),
    providerId: ProviderIdSchema.optional(),
    default_model_params: unknownRecord.optional(),
    defaultModelParams: unknownRecord.optional(),
    model_selection_enabled: z.boolean().optional(),
    modelSelectionEnabled: z.boolean().optional()
  })
  .transform((body, ctx) => {
    const agentId = firstString(body.agent_id, body.agentId);
    if (!agentId) {
      ctx.addIssue({ code: "custom", path: ["agent_id"], message: "agent_id is required" });
      return z.NEVER;
    }
    return {
      agentId,
      displayName: firstString(body.display_name, body.displayName),
      prompt: body.prompt,
      summary: body.summary,
      skillList:
        body.skill_list === null || body.skillList === null ? [] : dedupeStrings(body.skill_list ?? body.skillList),
      providerId: body.provider_id ?? body.providerId,
      defaultModelParams: body.default_model_params ?? body.defaultModelParams,
      modelSelectionEnabled: body.model_selection_enabled ?? body.modelSelectionEnabled
    };
  });

export const CatalogAgentPatchRequestSchema = z
  .object({
    display_name: optionalString,
    displayName: optionalString,
    prompt: optionalString,
    summary: nullableStringPatch,
    skill_list: stringArray.nullable(),
    skillList: stringArray.nullable(),
    provider_id: ProviderIdSchema.optional(),
    providerId: ProviderIdSchema.optional(),
    default_model_params: unknownRecord.optional(),
    defaultModelParams: unknownRecord.optional(),
    model_selection_enabled: z.boolean().optional(),
    modelSelectionEnabled: z.boolean().optional()
  })
  .transform((body) => ({
    displayName: firstString(body.display_name, body.displayName),
    prompt: body.prompt,
    summary: body.summary,
    skillList:
      body.skill_list === null || body.skillList === null ? [] : dedupeStrings(body.skill_list ?? body.skillList),
    providerId: body.provider_id ?? body.providerId,
    defaultModelParams: body.default_model_params ?? body.defaultModelParams,
    modelSelectionEnabled: body.model_selection_enabled ?? body.modelSelectionEnabled
  }));

export const CatalogSkillImportRequestSchema = z
  .object({
    sources: z.union([z.array(z.string()), z.string()]).optional(),
    paths: z.union([z.array(z.string()), z.string()]).optional(),
    source: optionalString,
    recursive: z.boolean().optional()
  })
  .transform((body, ctx) => {
    const raw = body.sources ?? body.paths ?? body.source;
    const sources = Array.isArray(raw)
      ? raw.map((item) => item.trim()).filter((item) => item.length > 0)
      : typeof raw === "string" && raw.trim().length > 0
        ? [raw.trim()]
        : [];
    if (sources.length === 0) {
      ctx.addIssue({ code: "custom", path: ["sources"], message: "sources is required" });
      return z.NEVER;
    }
    return { sources, recursive: body.recursive ?? true };
  });

export const CatalogSkillListCreateRequestSchema = z
  .object({
    list_id: optionalString,
    listId: optionalString,
    display_name: optionalString,
    displayName: optionalString,
    description: optionalString,
    include_all: z.boolean().optional(),
    includeAll: z.boolean().optional(),
    skill_ids: stringArray,
    skillIds: stringArray
  })
  .transform((body, ctx) => {
    const listId = firstString(body.list_id, body.listId);
    if (!listId) {
      ctx.addIssue({ code: "custom", path: ["list_id"], message: "list_id is required" });
      return z.NEVER;
    }
    return {
      listId,
      displayName: firstString(body.display_name, body.displayName),
      description: body.description,
      includeAll: body.include_all ?? body.includeAll ?? false,
      skillIds: dedupeStrings(body.skill_ids ?? body.skillIds)
    };
  });

export const CatalogSkillListPatchRequestSchema = z
  .object({
    display_name: optionalString,
    displayName: optionalString,
    description: nullableStringPatch,
    include_all: z.boolean().optional(),
    includeAll: z.boolean().optional(),
    skill_ids: stringArray.nullable(),
    skillIds: stringArray.nullable()
  })
  .transform((body) => ({
    displayName: firstString(body.display_name, body.displayName),
    description: body.description,
    includeAll: body.include_all ?? body.includeAll,
    skillIds: body.skill_ids === null || body.skillIds === null ? [] : dedupeStrings(body.skill_ids ?? body.skillIds),
    hasIncludeAll: body.include_all !== undefined || body.includeAll !== undefined,
    hasSkillIds: body.skill_ids !== undefined || body.skillIds !== undefined
  }));

export type CatalogAgentCreatePublicRequest = z.input<typeof CatalogAgentCreateRequestSchema>;
export type CatalogAgentPatchPublicRequest = z.input<typeof CatalogAgentPatchRequestSchema>;
export type CatalogAgentTemplateCreatePublicRequest = z.input<typeof CatalogAgentTemplateCreateRequestSchema>;
export type CatalogAgentTemplatePatchPublicRequest = z.input<typeof CatalogAgentTemplatePatchRequestSchema>;
export type CatalogTeamCreatePublicRequest = z.input<typeof CatalogTeamCreateRequestSchema>;
export type CatalogTeamUpdatePublicRequest = z.input<typeof CatalogTeamUpdateRequestSchema>;
export type CatalogSkillImportPublicRequest = z.input<typeof CatalogSkillImportRequestSchema>;
export type CatalogSkillListCreatePublicRequest = z.input<typeof CatalogSkillListCreateRequestSchema>;
export type CatalogSkillListPatchPublicRequest = z.input<typeof CatalogSkillListPatchRequestSchema>;
