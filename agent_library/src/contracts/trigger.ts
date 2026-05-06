import { z } from "zod";
import {
  firstString,
  optionalString,
  ProviderIdSchema,
  readInteger,
  requiredString,
  stringMap,
  unknownRecord
} from "./common.js";

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = readInteger(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

export const TriggerSessionModeSchema = z.enum(["fresh", "reuse_provider_session"]);
export type TriggerSessionMode = z.infer<typeof TriggerSessionModeSchema>;

function firstSessionMode(...values: unknown[]): TriggerSessionMode | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim();
    if (normalized === "fresh" || normalized === "reuse_provider_session") {
      return normalized;
    }
  }
  return undefined;
}

export const TriggerPluginManifestSchema = z
  .object({
    schema_version: optionalString,
    schemaVersion: optionalString,
    plugin_id: optionalString,
    pluginId: optionalString,
    name: requiredString,
    description: optionalString,
    entry: requiredString
  })
  .transform((body, ctx) => {
    const pluginId = firstString(body.plugin_id, body.pluginId);
    if (!pluginId) {
      ctx.addIssue({ code: "custom", path: ["plugin_id"], message: "plugin_id is required" });
      return z.NEVER;
    }
    return {
      schemaVersion: firstString(body.schema_version, body.schemaVersion) ?? "1.0",
      pluginId,
      name: body.name,
      description: body.description,
      entry: body.entry
    };
  });

export type TriggerPluginManifest = z.infer<typeof TriggerPluginManifestSchema>;

export const TriggerPluginImportRequestSchema = z
  .object({
    source: optionalString,
    source_path: optionalString,
    sourcePath: optionalString
  })
  .transform((body, ctx) => {
    const source = firstString(body.source, body.source_path, body.sourcePath);
    if (!source) {
      ctx.addIssue({ code: "custom", path: ["source"], message: "source is required" });
      return z.NEVER;
    }
    return { source };
  });

export type TriggerPluginImportRequest = z.infer<typeof TriggerPluginImportRequestSchema>;

export const TriggerConfigCreateRequestSchema = z
  .object({
    trigger_id: optionalString,
    triggerId: optionalString,
    plugin_id: optionalString,
    pluginId: optionalString,
    enabled: z.boolean().optional(),
    interval_seconds: z.union([z.number(), z.string()]).optional(),
    intervalSeconds: z.union([z.number(), z.string()]).optional(),
    workflow_template_id: optionalString,
    workflowTemplateId: optionalString,
    workspace_path: optionalString,
    workspacePath: optionalString,
    default_variables: stringMap,
    defaultVariables: stringMap,
    hook_timeout_ms: z.union([z.number(), z.string()]).optional(),
    hookTimeoutMs: z.union([z.number(), z.string()]).optional(),
    session_mode: optionalString,
    sessionMode: optionalString
  })
  .transform((body, ctx) => {
    const triggerId = firstString(body.trigger_id, body.triggerId);
    const pluginId = firstString(body.plugin_id, body.pluginId);
    const workflowTemplateId = firstString(body.workflow_template_id, body.workflowTemplateId);
    const workspacePath = firstString(body.workspace_path, body.workspacePath);
    if (!triggerId) ctx.addIssue({ code: "custom", path: ["trigger_id"], message: "trigger_id is required" });
    if (!pluginId) ctx.addIssue({ code: "custom", path: ["plugin_id"], message: "plugin_id is required" });
    if (!workflowTemplateId)
      ctx.addIssue({ code: "custom", path: ["workflow_template_id"], message: "workflow_template_id is required" });
    if (!workspacePath)
      ctx.addIssue({ code: "custom", path: ["workspace_path"], message: "workspace_path is required" });
    if (!triggerId || !pluginId || !workflowTemplateId || !workspacePath) {
      return z.NEVER;
    }
    return {
      triggerId,
      pluginId,
      enabled: body.enabled ?? true,
      intervalSeconds: positiveInteger(firstNumber(body.interval_seconds, body.intervalSeconds), 60),
      workflowTemplateId,
      workspacePath,
      defaultVariables: body.default_variables ?? body.defaultVariables,
      hookTimeoutMs: positiveInteger(firstNumber(body.hook_timeout_ms, body.hookTimeoutMs), 30_000),
      sessionMode: firstSessionMode(body.session_mode, body.sessionMode) ?? "fresh"
    };
  });

export type TriggerConfigCreateRequest = z.infer<typeof TriggerConfigCreateRequestSchema>;

export const TriggerConfigPatchRequestSchema = z
  .object({
    plugin_id: optionalString,
    pluginId: optionalString,
    enabled: z.boolean().optional(),
    interval_seconds: z.union([z.number(), z.string()]).optional(),
    intervalSeconds: z.union([z.number(), z.string()]).optional(),
    workflow_template_id: optionalString,
    workflowTemplateId: optionalString,
    workspace_path: optionalString,
    workspacePath: optionalString,
    default_variables: stringMap.nullable(),
    defaultVariables: stringMap.nullable(),
    hook_timeout_ms: z.union([z.number(), z.string()]).optional(),
    hookTimeoutMs: z.union([z.number(), z.string()]).optional(),
    session_mode: optionalString,
    sessionMode: optionalString
  })
  .transform((body) => ({
    pluginId: firstString(body.plugin_id, body.pluginId),
    enabled: firstBoolean(body.enabled),
    intervalSeconds:
      body.interval_seconds !== undefined || body.intervalSeconds !== undefined
        ? positiveInteger(firstNumber(body.interval_seconds, body.intervalSeconds), 60)
        : undefined,
    workflowTemplateId: firstString(body.workflow_template_id, body.workflowTemplateId),
    workspacePath: firstString(body.workspace_path, body.workspacePath),
    defaultVariables:
      body.default_variables === null || body.defaultVariables === null
        ? null
        : (body.default_variables ?? body.defaultVariables),
    hookTimeoutMs:
      body.hook_timeout_ms !== undefined || body.hookTimeoutMs !== undefined
        ? positiveInteger(firstNumber(body.hook_timeout_ms, body.hookTimeoutMs), 30_000)
        : undefined,
    sessionMode: firstSessionMode(body.session_mode, body.sessionMode)
  }));

export type TriggerConfigPatchRequest = z.infer<typeof TriggerConfigPatchRequestSchema>;

export const TriggerSessionBindingResetRequestSchema = z
  .object({
    role: optionalString,
    provider: ProviderIdSchema.optional()
  })
  .transform((body) => ({
    role: body.role,
    provider: body.provider
  }));

export type TriggerSessionBindingResetRequest = z.infer<typeof TriggerSessionBindingResetRequestSchema>;

export const TriggerCheckResultSchema = z
  .object({
    need_trigger: z.boolean().optional(),
    needTrigger: z.boolean().optional(),
    reason: optionalString,
    payload: unknownRecord.optional(),
    data: unknownRecord.optional()
  })
  .passthrough()
  .transform((body) => ({
    needTrigger: body.need_trigger ?? body.needTrigger ?? false,
    reason: body.reason,
    payload: body.payload ?? body.data
  }));

export type TriggerCheckResult = z.infer<typeof TriggerCheckResultSchema>;

export const TriggerActionSchema = z
  .object({
    should_trigger: z.boolean().optional(),
    shouldTrigger: z.boolean().optional(),
    workflow_template_id: optionalString,
    workflowTemplateId: optionalString,
    workspace_path: optionalString,
    workspacePath: optionalString,
    run_name: optionalString,
    runName: optionalString,
    description: optionalString,
    reason: optionalString,
    variables: stringMap,
    task_overrides: stringMap,
    taskOverrides: stringMap,
    auto_dispatch_remaining: z.union([z.number(), z.string()]).optional(),
    autoDispatchRemaining: z.union([z.number(), z.string()]).optional()
  })
  .passthrough()
  .transform((body) => ({
    shouldTrigger: body.should_trigger ?? body.shouldTrigger ?? true,
    workflowTemplateId: firstString(body.workflow_template_id, body.workflowTemplateId),
    workspacePath: firstString(body.workspace_path, body.workspacePath),
    runName: firstString(body.run_name, body.runName),
    description: body.description,
    reason: body.reason,
    variables: body.variables,
    taskOverrides: body.task_overrides ?? body.taskOverrides,
    autoDispatchRemaining: firstNumber(body.auto_dispatch_remaining, body.autoDispatchRemaining)
  }));

export type TriggerAction = z.infer<typeof TriggerActionSchema>;

export const TriggerCompletionVerdictSchema = z
  .object({
    accepted: z.boolean().optional(),
    success: z.boolean().optional(),
    summary: optionalString,
    reason: optionalString,
    payload: unknownRecord.optional()
  })
  .passthrough()
  .transform((body) => ({
    accepted: body.accepted ?? body.success ?? false,
    summary: body.summary,
    reason: body.reason,
    payload: body.payload
  }));

export type TriggerCompletionVerdict = z.infer<typeof TriggerCompletionVerdictSchema>;
