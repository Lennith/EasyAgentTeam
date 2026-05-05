import { z } from "zod";
import {
  dedupeStrings,
  firstString,
  optionalNullableString,
  optionalString,
  ProviderIdSchema,
  readBoolean,
  readInteger,
  requiredString,
  routeDiscussRounds,
  routeTable,
  stringArray,
  unknownRecord
} from "./common.js";

export const ProjectTaskStateSchema = z.enum([
  "PLANNED",
  "READY",
  "DISPATCHED",
  "IN_PROGRESS",
  "BLOCKED_DEP",
  "DONE",
  "CANCELED"
]);

export const ProjectTaskActionTypeSchema = z.enum([
  "TASK_CREATE",
  "TASK_UPDATE",
  "TASK_ASSIGN",
  "TASK_DISCUSS_REQUEST",
  "TASK_DISCUSS_REPLY",
  "TASK_DISCUSS_CLOSED",
  "TASK_REPORT"
]);

const ProjectTaskReportOutcomeSchema = z.enum(["IN_PROGRESS", "BLOCKED_DEP", "DONE", "CANCELED"]);

const ProjectTaskActionResultRawSchema = z.object({
  task_id: optionalString,
  taskId: optionalString,
  outcome: ProjectTaskReportOutcomeSchema.optional(),
  summary: optionalString,
  artifacts: stringArray,
  blockers: stringArray
});

const ProjectTaskActionRawSchema = z
  .object({
    action_type: ProjectTaskActionTypeSchema.optional(),
    actionType: ProjectTaskActionTypeSchema.optional(),
    request_id: optionalString,
    requestId: optionalString,
    from_agent: optionalString,
    fromAgent: optionalString,
    from_session_id: optionalString.nullable(),
    fromSessionId: optionalString.nullable(),
    to_role: optionalString,
    toRole: optionalString,
    to_session_id: optionalString.nullable(),
    toSessionId: optionalString.nullable(),
    payload: unknownRecord.optional(),
    task_id: optionalString,
    taskId: optionalString,
    title: optionalString,
    parent_task_id: optionalString,
    parentTaskId: optionalString,
    owner_role: optionalString,
    ownerRole: optionalString,
    task_kind: optionalString,
    taskKind: optionalString,
    dependencies: stringArray,
    acceptance: stringArray,
    write_set: stringArray,
    writeSet: stringArray,
    artifacts: stringArray,
    state: optionalString,
    content: optionalString,
    thread_id: optionalString,
    threadId: optionalString,
    summary: optionalString,
    results: z.array(ProjectTaskActionResultRawSchema).optional()
  })
  .passthrough();

function normalizeTaskActionInput(body: z.infer<typeof ProjectTaskActionRawSchema>): Record<string, unknown> {
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
  const merged = { ...body, ...payload } as Record<string, unknown>;
  const taskId = firstString(merged.task_id as string | undefined, merged.taskId as string | undefined);
  const parentTaskId = firstString(
    merged.parent_task_id as string | undefined,
    merged.parentTaskId as string | undefined
  );
  const ownerRole = firstString(merged.owner_role as string | undefined, merged.ownerRole as string | undefined);
  if (taskId) {
    merged.task_id = taskId;
    merged.taskId = taskId;
  }
  if (parentTaskId) {
    merged.parent_task_id = parentTaskId;
    merged.parentTaskId = parentTaskId;
  }
  if (ownerRole) {
    merged.owner_role = ownerRole;
    merged.ownerRole = ownerRole;
  }
  const results = Array.isArray(merged.results)
    ? ProjectTaskActionResultRawSchema.array()
        .parse(merged.results)
        .map((row) => {
          const resultTaskId = firstString(row.task_id, row.taskId) ?? "";
          return {
            ...row,
            task_id: resultTaskId,
            taskId: resultTaskId,
            outcome: row.outcome,
            summary: row.summary,
            artifacts: row.artifacts,
            blockers: row.blockers
          };
        })
    : undefined;
  if (results) {
    merged.results = results;
  }
  return merged;
}

export const ProjectTaskActionRequestSchema = ProjectTaskActionRawSchema.transform((body, ctx) => {
  const actionType = body.action_type ?? body.actionType;
  if (!actionType) {
    ctx.addIssue({ code: "custom", path: ["action_type"], message: "action_type is required" });
    return z.NEVER;
  }
  const actionInput = normalizeTaskActionInput(body);
  if (actionType === "TASK_REPORT" && (!Array.isArray(actionInput.results) || actionInput.results.length === 0)) {
    ctx.addIssue({ code: "custom", path: ["payload", "results"], message: "TASK_REPORT requires results[]" });
    return z.NEVER;
  }
  if (actionType === "TASK_CREATE") {
    const title = firstString(actionInput.title as string | undefined);
    const taskId = firstString(actionInput.task_id as string | undefined, actionInput.taskId as string | undefined);
    const ownerRole = firstString(
      actionInput.owner_role as string | undefined,
      actionInput.ownerRole as string | undefined
    );
    const parentTaskId = firstString(
      actionInput.parent_task_id as string | undefined,
      actionInput.parentTaskId as string | undefined
    );
    const taskKind = firstString(
      actionInput.task_kind as string | undefined,
      actionInput.taskKind as string | undefined
    );
    if (!title || !taskId || !ownerRole || (!parentTaskId && taskKind !== "PROJECT_ROOT")) {
      ctx.addIssue({
        code: "custom",
        path: ["payload"],
        message: "TASK_CREATE requires task_id, title, parent_task_id, and owner_role"
      });
      return z.NEVER;
    }
  }
  return {
    actionType,
    requestId: firstString(body.request_id, body.requestId),
    fromAgent: firstString(body.from_agent, body.fromAgent) ?? "manager",
    fromSessionId: firstString(body.from_session_id ?? undefined, body.fromSessionId ?? undefined),
    toRole: firstString(body.to_role, body.toRole),
    toSessionId: firstString(body.to_session_id ?? undefined, body.toSessionId ?? undefined),
    actionInput,
    rawBody: body as Record<string, unknown>
  };
});

export type ProjectTaskActionRequestContract = z.infer<typeof ProjectTaskActionRequestSchema>;
export type ProjectTaskActionPublicRequest = z.input<typeof ProjectTaskActionRequestSchema>;

export const ProjectTaskPatchRequestSchema = z
  .object({
    title: optionalString,
    state: ProjectTaskStateSchema.optional(),
    owner_role: optionalString,
    ownerRole: optionalString,
    dependencies: stringArray,
    write_set: stringArray,
    writeSet: stringArray,
    acceptance: stringArray,
    artifacts: stringArray,
    priority: z.number().optional(),
    alert: optionalString.nullable()
  })
  .transform((body) => ({
    title: body.title,
    state: body.state,
    ownerRole: firstString(body.owner_role, body.ownerRole),
    dependencies: body.dependencies,
    writeSet: body.write_set ?? body.writeSet,
    acceptance: body.acceptance,
    artifacts: body.artifacts,
    priority:
      typeof body.priority === "number" && Number.isFinite(body.priority) ? Math.floor(body.priority) : undefined,
    alert: body.alert === null ? null : body.alert
  }));

export type ProjectTaskPatchRequestContract = z.infer<typeof ProjectTaskPatchRequestSchema>;
export type ProjectTaskPatchPublicRequest = z.input<typeof ProjectTaskPatchRequestSchema>;

export const ProjectMessageTypeSchema = z.enum([
  "MANAGER_MESSAGE",
  "TASK_DISCUSS_REQUEST",
  "TASK_DISCUSS_REPLY",
  "TASK_DISCUSS_CLOSED"
]);

export const ProjectMessageSendRequestSchema = z
  .object({
    from_agent: optionalString,
    fromAgent: optionalString,
    from_session_id: optionalString,
    fromSessionId: optionalString,
    message_type: ProjectMessageTypeSchema.optional(),
    messageType: ProjectMessageTypeSchema.optional(),
    to: z
      .object({
        agent: optionalString,
        role: optionalString,
        session_id: optionalNullableString,
        sessionId: optionalNullableString
      })
      .optional(),
    to_role: optionalString,
    to_agent: optionalString,
    toRole: optionalString,
    session_id: optionalNullableString,
    sessionId: optionalNullableString,
    to_session_id: optionalNullableString,
    toSessionId: optionalNullableString,
    task_id: optionalString,
    taskId: optionalString,
    request_id: optionalString,
    requestId: optionalString,
    parent_request_id: optionalString,
    parentRequestId: optionalString,
    content: requiredString,
    discuss: z.unknown().optional()
  })
  .passthrough()
  .transform((body) => {
    const fromAgent = firstString(body.from_agent, body.fromAgent) ?? "manager";
    return {
      fromAgent,
      fromSessionId:
        firstString(body.from_session_id, body.fromSessionId) ??
        (fromAgent === "manager" ? "manager-system" : "agent-session-unknown"),
      messageType: body.message_type ?? body.messageType ?? "MANAGER_MESSAGE",
      toRole: firstString(body.to?.agent, body.to?.role, body.to_role, body.to_agent, body.toRole),
      toSessionId: firstString(
        body.to?.session_id,
        body.to?.sessionId,
        body.session_id,
        body.sessionId,
        body.to_session_id,
        body.toSessionId
      ),
      taskId: firstString(body.task_id, body.taskId),
      requestId: firstString(body.request_id, body.requestId),
      parentRequestId: firstString(body.parent_request_id, body.parentRequestId),
      content: body.content,
      discuss: body.discuss,
      rawBody: body as Record<string, unknown>
    };
  });

export type ProjectMessageSendRequestContract = z.infer<typeof ProjectMessageSendRequestSchema>;
export type ProjectMessageSendPublicRequest = z.input<typeof ProjectMessageSendRequestSchema>;

export const AgentModelConfigSchema = z.object({
  provider_id: ProviderIdSchema,
  model: requiredString,
  effort: z.enum(["low", "medium", "high"]).optional()
});

export const ProjectCreateRequestSchema = z
  .object({
    project_id: optionalString,
    projectId: optionalString,
    name: requiredString,
    workspace_path: optionalString,
    workspacePath: optionalString,
    template_id: optionalString,
    templateId: optionalString,
    team_id: optionalString,
    teamId: optionalString,
    agent_ids: stringArray,
    agentIds: stringArray,
    route_table: routeTable,
    routeTable,
    task_assign_route_table: routeTable,
    taskAssignRouteTable: routeTable,
    route_discuss_rounds: routeDiscussRounds,
    routeDiscussRounds: routeDiscussRounds,
    agent_model_configs: z.record(z.string(), AgentModelConfigSchema).optional(),
    agentModelConfigs: z.record(z.string(), AgentModelConfigSchema).optional(),
    role_session_map: z.record(z.string(), z.string()).optional(),
    roleSessionMap: z.record(z.string(), z.string()).optional(),
    auto_dispatch_enabled: z.boolean().optional(),
    autoDispatchEnabled: z.boolean().optional(),
    auto_dispatch_remaining: z.union([z.number(), z.string()]).optional(),
    autoDispatchRemaining: z.union([z.number(), z.string()]).optional(),
    hold_enabled: z.boolean().optional(),
    holdEnabled: z.boolean().optional(),
    reminder_mode: z.enum(["backoff", "fixed_interval"]).optional(),
    reminderMode: z.enum(["backoff", "fixed_interval"]).optional()
  })
  .transform((body, ctx) => {
    const projectId = firstString(body.project_id, body.projectId);
    const workspacePath = firstString(body.workspace_path, body.workspacePath);
    if (!projectId) {
      ctx.addIssue({ code: "custom", path: ["project_id"], message: "project_id is required" });
    }
    if (!workspacePath) {
      ctx.addIssue({ code: "custom", path: ["workspace_path"], message: "workspace_path is required" });
    }
    if (!projectId || !workspacePath) {
      return z.NEVER;
    }
    return {
      projectId,
      name: body.name,
      workspacePath,
      templateId: firstString(body.template_id, body.templateId),
      teamId: firstString(body.team_id, body.teamId),
      agentIds: dedupeStrings(body.agent_ids ?? body.agentIds),
      routeTable: body.route_table ?? body.routeTable,
      taskAssignRouteTable: body.task_assign_route_table ?? body.taskAssignRouteTable,
      routeDiscussRounds: body.route_discuss_rounds ?? body.routeDiscussRounds,
      agentModelConfigs: body.agent_model_configs ?? body.agentModelConfigs,
      roleSessionMap: body.role_session_map ?? body.roleSessionMap,
      autoDispatchEnabled: readBoolean(body.auto_dispatch_enabled ?? body.autoDispatchEnabled, true),
      autoDispatchRemaining: readInteger(body.auto_dispatch_remaining ?? body.autoDispatchRemaining) ?? 5,
      holdEnabled: readBoolean(body.hold_enabled ?? body.holdEnabled, false),
      reminderMode: body.reminder_mode ?? body.reminderMode ?? "backoff"
    };
  });

export const ProjectRoutingConfigRequestSchema = z
  .object({
    agent_ids: stringArray,
    agentIds: stringArray,
    route_table: routeTable,
    routeTable,
    route_discuss_rounds: routeDiscussRounds,
    routeDiscussRounds: routeDiscussRounds,
    agent_model_configs: z.record(z.string(), AgentModelConfigSchema).optional(),
    agentModelConfigs: z.record(z.string(), AgentModelConfigSchema).optional()
  })
  .transform((body, ctx) => {
    const agentIds = dedupeStrings(body.agent_ids ?? body.agentIds);
    const resolvedRouteTable = body.route_table ?? body.routeTable;
    if (!agentIds || !resolvedRouteTable) {
      ctx.addIssue({ code: "custom", message: "agent_ids and route_table are required" });
      return z.NEVER;
    }
    return {
      agentIds,
      routeTable: resolvedRouteTable,
      routeDiscussRounds: body.route_discuss_rounds ?? body.routeDiscussRounds,
      agentModelConfigs: body.agent_model_configs ?? body.agentModelConfigs
    };
  });

export const ProjectTaskAssignRoutingRequestSchema = z
  .object({
    task_assign_route_table: routeTable,
    taskAssignRouteTable: routeTable
  })
  .transform((body, ctx) => {
    const taskAssignRouteTable = body.task_assign_route_table ?? body.taskAssignRouteTable;
    if (!taskAssignRouteTable) {
      ctx.addIssue({ code: "custom", message: "task_assign_route_table is required" });
      return z.NEVER;
    }
    return { taskAssignRouteTable };
  });

export const ProjectOrchestratorSettingsPatchRequestSchema = z
  .object({
    auto_dispatch_enabled: z.boolean().optional(),
    autoDispatchEnabled: z.boolean().optional(),
    auto_dispatch_remaining: z.union([z.number(), z.string()]).optional(),
    autoDispatchRemaining: z.union([z.number(), z.string()]).optional(),
    hold_enabled: z.boolean().optional(),
    holdEnabled: z.boolean().optional(),
    reminder_mode: z.enum(["backoff", "fixed_interval"]).optional(),
    reminderMode: z.enum(["backoff", "fixed_interval"]).optional()
  })
  .transform((body) => ({
    autoDispatchEnabled: body.auto_dispatch_enabled ?? body.autoDispatchEnabled,
    autoDispatchRemaining: readInteger(body.auto_dispatch_remaining ?? body.autoDispatchRemaining),
    holdEnabled: body.hold_enabled ?? body.holdEnabled,
    reminderMode: body.reminder_mode ?? body.reminderMode,
    hasAutoDispatchEnabled: body.auto_dispatch_enabled !== undefined || body.autoDispatchEnabled !== undefined,
    hasAutoDispatchRemaining: body.auto_dispatch_remaining !== undefined || body.autoDispatchRemaining !== undefined,
    hasHoldEnabled: body.hold_enabled !== undefined || body.holdEnabled !== undefined,
    hasReminderMode: body.reminder_mode !== undefined || body.reminderMode !== undefined
  }));

export const ProjectDispatchRequestSchema = z
  .object({
    role: optionalString,
    to_role: optionalString,
    toRole: optionalString,
    session_id: optionalString,
    sessionId: optionalString,
    task_id: optionalString,
    taskId: optionalString,
    force: z.boolean().optional(),
    only_idle: z.boolean().optional(),
    onlyIdle: z.boolean().optional()
  })
  .transform((body) => ({
    role: firstString(body.role, body.to_role, body.toRole),
    sessionId: firstString(body.session_id, body.sessionId),
    taskId: firstString(body.task_id, body.taskId),
    force: Boolean(body.force ?? false),
    onlyIdle:
      body.only_idle === undefined && body.onlyIdle === undefined ? false : Boolean(body.only_idle ?? body.onlyIdle)
  }));

export const ProjectDispatchMessageRequestSchema = z
  .object({
    message_id: optionalString,
    messageId: optionalString,
    session_id: optionalString,
    sessionId: optionalString,
    force: z.boolean().optional(),
    only_idle: z.boolean().optional(),
    onlyIdle: z.boolean().optional()
  })
  .transform((body, ctx) => {
    const messageId = firstString(body.message_id, body.messageId);
    if (!messageId) {
      ctx.addIssue({ code: "custom", path: ["message_id"], message: "message_id is required" });
      return z.NEVER;
    }
    return {
      messageId,
      sessionId: firstString(body.session_id, body.sessionId),
      force: Boolean(body.force ?? false),
      onlyIdle:
        body.only_idle === undefined && body.onlyIdle === undefined ? false : Boolean(body.only_idle ?? body.onlyIdle)
    };
  });

export type ProjectCreatePublicRequest = z.input<typeof ProjectCreateRequestSchema>;
export type ProjectRoutingConfigPublicRequest = z.input<typeof ProjectRoutingConfigRequestSchema>;
export type ProjectDispatchPublicRequest = z.input<typeof ProjectDispatchRequestSchema>;
