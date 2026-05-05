import { z } from "zod";

const emptyToUndefined = (value: unknown): unknown => (typeof value === "string" ? value.trim() || undefined : value);

const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional()).optional();
const requiredString = z.preprocess(emptyToUndefined, z.string().min(1));
const stringArray = z
  .array(
    z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1))
  )
  .optional();
const stringMap = z.record(z.string(), z.string()).optional();
const routeTable = z.record(z.string(), z.array(z.string())).optional();
const routeDiscussRounds = z.record(z.string(), z.record(z.string(), z.number().int().positive())).optional();

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

export const WorkflowTaskOutcomeSchema = z.enum(["IN_PROGRESS", "BLOCKED_DEP", "DONE", "CANCELED"]);

export const WorkflowTaskActionTypeSchema = z.enum([
  "TASK_CREATE",
  "TASK_DISCUSS_REQUEST",
  "TASK_DISCUSS_REPLY",
  "TASK_DISCUSS_CLOSED",
  "TASK_REPORT"
]);

const WorkflowTaskActionTaskRawSchema = z.object({
  task_id: optionalString,
  taskId: optionalString,
  title: optionalString,
  owner_role: optionalString,
  ownerRole: optionalString,
  parent_task_id: optionalString,
  parentTaskId: optionalString,
  dependencies: stringArray,
  acceptance: stringArray,
  artifacts: stringArray
});

const WorkflowTaskActionResultRawSchema = z.object({
  task_id: optionalString,
  taskId: optionalString,
  outcome: WorkflowTaskOutcomeSchema.optional(),
  summary: optionalString,
  blockers: stringArray
});

const WorkflowTaskActionDiscussRawSchema = z.object({
  thread_id: optionalString,
  threadId: optionalString,
  request_id: optionalString,
  requestId: optionalString
});

const WorkflowTaskActionPublicTaskSchema = z.object({
  task_id: requiredString,
  title: requiredString,
  owner_role: requiredString,
  parent_task_id: optionalString,
  dependencies: stringArray,
  acceptance: stringArray,
  artifacts: stringArray
});

const WorkflowTaskActionPublicResultSchema = z.object({
  task_id: requiredString,
  outcome: WorkflowTaskOutcomeSchema,
  summary: optionalString,
  blockers: stringArray
});

export const WorkflowTaskActionPublicRequestSchema = z
  .object({
    action_type: WorkflowTaskActionTypeSchema,
    from_agent: optionalString,
    from_session_id: optionalString,
    to_role: optionalString,
    to_session_id: optionalString,
    task_id: optionalString,
    content: optionalString,
    task: WorkflowTaskActionPublicTaskSchema.optional(),
    discuss: z
      .object({
        thread_id: optionalString,
        request_id: optionalString
      })
      .optional(),
    results: z.array(WorkflowTaskActionPublicResultSchema).optional()
  })
  .superRefine((body, ctx) => {
    if (body.action_type === "TASK_CREATE" && !body.task) {
      ctx.addIssue({ code: "custom", path: ["task"], message: "TASK_CREATE requires task" });
    }
    if (body.action_type === "TASK_REPORT" && (!body.results || body.results.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["results"], message: "TASK_REPORT requires at least one result" });
    }
  });

export type WorkflowTaskActionPublicRequest = z.infer<typeof WorkflowTaskActionPublicRequestSchema>;

export const WorkflowTaskActionRequestSchema = z
  .object({
    action_type: WorkflowTaskActionTypeSchema.optional(),
    actionType: WorkflowTaskActionTypeSchema.optional(),
    from_agent: optionalString,
    fromAgent: optionalString,
    from_session_id: optionalString,
    fromSessionId: optionalString,
    to_role: optionalString,
    toRole: optionalString,
    to_session_id: optionalString,
    toSessionId: optionalString,
    task_id: optionalString,
    taskId: optionalString,
    content: optionalString,
    task: WorkflowTaskActionTaskRawSchema.optional(),
    discuss: WorkflowTaskActionDiscussRawSchema.optional(),
    results: z.array(WorkflowTaskActionResultRawSchema).optional()
  })
  .transform((body, ctx) => {
    const actionType = body.action_type ?? body.actionType;
    if (!actionType) {
      ctx.addIssue({ code: "custom", message: "action_type is required" });
      return z.NEVER;
    }
    const task = body.task
      ? {
          taskId: firstString(body.task.task_id, body.task.taskId) ?? "",
          title: body.task.title ?? "",
          ownerRole: firstString(body.task.owner_role, body.task.ownerRole) ?? "",
          parentTaskId: firstString(body.task.parent_task_id, body.task.parentTaskId),
          dependencies: body.task.dependencies,
          acceptance: body.task.acceptance,
          artifacts: body.task.artifacts
        }
      : undefined;
    const results = body.results?.flatMap((row) => {
      const taskId = firstString(row.task_id, row.taskId) ?? "";
      if (!taskId || !row.outcome) return [];
      return [
        {
          taskId,
          outcome: row.outcome,
          summary: row.summary,
          blockers: row.blockers
        }
      ];
    });
    if (actionType === "TASK_REPORT" && (!results || results.length === 0)) {
      ctx.addIssue({ code: "custom", message: "TASK_REPORT requires at least one result" });
      return z.NEVER;
    }
    if (actionType === "TASK_CREATE" && (!task || !task.taskId || !task.title || !task.ownerRole)) {
      ctx.addIssue({ code: "custom", message: "TASK_CREATE requires task_id, title, and owner_role" });
      return z.NEVER;
    }
    return {
      actionType,
      fromAgent: firstString(body.from_agent, body.fromAgent),
      fromSessionId: firstString(body.from_session_id, body.fromSessionId),
      toRole: firstString(body.to_role, body.toRole),
      toSessionId: firstString(body.to_session_id, body.toSessionId),
      taskId: firstString(body.task_id, body.taskId),
      content: body.content,
      task,
      discuss: body.discuss
        ? {
            threadId: firstString(body.discuss.thread_id, body.discuss.threadId),
            requestId: firstString(body.discuss.request_id, body.discuss.requestId)
          }
        : undefined,
      results
    };
  });

export type WorkflowTaskActionRequestContract = z.infer<typeof WorkflowTaskActionRequestSchema>;

export const WorkflowTaskActionResultSchema = z.object({
  success: z.boolean(),
  requestId: z.string(),
  actionType: WorkflowTaskActionTypeSchema,
  createdTaskId: z.string().optional(),
  messageId: z.string().optional(),
  partialApplied: z.boolean(),
  appliedTaskIds: z.array(z.string()),
  rejectedResults: z.array(
    z.object({
      taskId: z.string(),
      reasonCode: z.string(),
      reason: z.string()
    })
  ),
  snapshot: z.unknown()
});

export type WorkflowTaskActionResultContract = z.infer<typeof WorkflowTaskActionResultSchema>;

const WorkflowTemplateTaskRawSchema = z.object({
  task_id: optionalString,
  taskId: optionalString,
  title: requiredString,
  owner_role: optionalString,
  ownerRole: optionalString,
  parent_task_id: optionalString,
  parentTaskId: optionalString,
  dependencies: stringArray,
  write_set: stringArray,
  writeSet: stringArray,
  acceptance: stringArray,
  artifacts: stringArray
});

export const WorkflowTemplateTaskPublicSchema = z.object({
  task_id: requiredString,
  title: requiredString,
  owner_role: requiredString,
  parent_task_id: optionalString,
  dependencies: stringArray,
  write_set: stringArray,
  acceptance: stringArray,
  artifacts: stringArray
});

export const WorkflowTemplatePublicPayloadSchema = z.object({
  template_id: requiredString,
  name: requiredString,
  description: optionalString.nullable(),
  tasks: z.array(WorkflowTemplateTaskPublicSchema).min(1),
  route_table: routeTable,
  task_assign_route_table: routeTable,
  route_discuss_rounds: routeDiscussRounds,
  default_variables: stringMap
});

export type WorkflowTemplatePublicPayload = z.infer<typeof WorkflowTemplatePublicPayloadSchema>;

export const WorkflowTemplatePatchPublicPayloadSchema = z.object({
  name: optionalString,
  description: optionalString.nullable(),
  tasks: z.array(WorkflowTemplateTaskPublicSchema).min(1).optional(),
  route_table: routeTable,
  task_assign_route_table: routeTable,
  route_discuss_rounds: routeDiscussRounds,
  default_variables: stringMap
});

export type WorkflowTemplatePatchPublicPayload = z.infer<typeof WorkflowTemplatePatchPublicPayloadSchema>;

export const WorkflowTemplatePayloadSchema = z
  .object({
    template_id: optionalString,
    templateId: optionalString,
    name: requiredString,
    description: optionalString.nullable(),
    tasks: z.array(WorkflowTemplateTaskRawSchema).min(1),
    route_table: routeTable,
    routeTable,
    task_assign_route_table: routeTable,
    taskAssignRouteTable: routeTable,
    route_discuss_rounds: routeDiscussRounds,
    routeDiscussRounds: routeDiscussRounds,
    default_variables: stringMap,
    defaultVariables: stringMap
  })
  .transform((body, ctx) => {
    const templateId = firstString(body.template_id, body.templateId);
    if (!templateId) {
      ctx.addIssue({ code: "custom", message: "template_id is required" });
      return z.NEVER;
    }
    const tasks = body.tasks.map((task) => ({
      taskId: firstString(task.task_id, task.taskId) ?? "",
      title: task.title,
      ownerRole: firstString(task.owner_role, task.ownerRole) ?? "",
      parentTaskId: firstString(task.parent_task_id, task.parentTaskId),
      dependencies: task.dependencies,
      writeSet: task.write_set ?? task.writeSet,
      acceptance: task.acceptance,
      artifacts: task.artifacts
    }));
    if (tasks.some((task) => !task.taskId || !task.ownerRole)) {
      ctx.addIssue({ code: "custom", message: "tasks require task_id, title, and owner_role" });
      return z.NEVER;
    }
    return {
      templateId,
      name: body.name,
      description: body.description ?? undefined,
      tasks,
      routeTable: body.route_table ?? body.routeTable,
      taskAssignRouteTable: body.task_assign_route_table ?? body.taskAssignRouteTable,
      routeDiscussRounds: body.route_discuss_rounds ?? body.routeDiscussRounds,
      defaultVariables: body.default_variables ?? body.defaultVariables
    };
  });

export type WorkflowTemplatePayloadContract = z.infer<typeof WorkflowTemplatePayloadSchema>;

export const WorkflowTemplatePatchPayloadSchema = z
  .object({
    name: optionalString,
    description: optionalString.nullable(),
    tasks: z.array(WorkflowTemplateTaskRawSchema).min(1).optional(),
    route_table: routeTable,
    routeTable,
    task_assign_route_table: routeTable,
    taskAssignRouteTable: routeTable,
    route_discuss_rounds: routeDiscussRounds,
    routeDiscussRounds: routeDiscussRounds,
    default_variables: stringMap,
    defaultVariables: stringMap
  })
  .transform((body, ctx) => {
    const tasks = body.tasks?.map((task) => ({
      taskId: firstString(task.task_id, task.taskId) ?? "",
      title: task.title,
      ownerRole: firstString(task.owner_role, task.ownerRole) ?? "",
      parentTaskId: firstString(task.parent_task_id, task.parentTaskId),
      dependencies: task.dependencies,
      writeSet: task.write_set ?? task.writeSet,
      acceptance: task.acceptance,
      artifacts: task.artifacts
    }));
    if (tasks?.some((task) => !task.taskId || !task.ownerRole)) {
      ctx.addIssue({ code: "custom", message: "tasks require task_id, title, and owner_role" });
      return z.NEVER;
    }
    return {
      name: body.name,
      description: body.description,
      tasks,
      routeTable: body.route_table ?? body.routeTable,
      taskAssignRouteTable: body.task_assign_route_table ?? body.taskAssignRouteTable,
      routeDiscussRounds: body.route_discuss_rounds ?? body.routeDiscussRounds,
      defaultVariables: body.default_variables ?? body.defaultVariables
    };
  });

export type WorkflowTemplatePatchPayloadContract = z.infer<typeof WorkflowTemplatePatchPayloadSchema>;

export const WorkflowTemplateRecordSchema = z.object({
  schemaVersion: z.literal("1.0"),
  templateId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  tasks: z.array(
    z.object({
      taskId: z.string(),
      title: z.string(),
      ownerRole: z.string(),
      parentTaskId: z.string().optional(),
      dependencies: z.array(z.string()).optional(),
      writeSet: z.array(z.string()).optional(),
      acceptance: z.array(z.string()).optional(),
      artifacts: z.array(z.string()).optional()
    })
  ),
  routeTable,
  taskAssignRouteTable: routeTable,
  routeDiscussRounds,
  defaultVariables: stringMap,
  createdAt: z.string(),
  updatedAt: z.string()
});

export type WorkflowTemplateRecordContract = z.infer<typeof WorkflowTemplateRecordSchema>;

export const WorkflowMessageTypeSchema = z.enum([
  "MANAGER_MESSAGE",
  "TASK_DISCUSS_REQUEST",
  "TASK_DISCUSS_REPLY",
  "TASK_DISCUSS_CLOSED"
]);

export const WorkflowMessageSendRequestSchema = z
  .object({
    from_agent: optionalString,
    fromAgent: optionalString,
    from_session_id: optionalString,
    fromSessionId: optionalString,
    message_type: WorkflowMessageTypeSchema.optional(),
    messageType: WorkflowMessageTypeSchema.optional(),
    to_role: optionalString,
    toRole: optionalString,
    to_session_id: optionalString,
    toSessionId: optionalString,
    to: z
      .object({
        agent: optionalString,
        role: optionalString,
        session_id: optionalString,
        sessionId: optionalString
      })
      .optional(),
    task_id: optionalString,
    taskId: optionalString,
    request_id: optionalString,
    requestId: optionalString,
    parent_request_id: optionalString,
    parentRequestId: optionalString,
    content: requiredString,
    discuss: WorkflowTaskActionDiscussRawSchema.optional()
  })
  .transform((body) => {
    const fromAgent = firstString(body.from_agent, body.fromAgent) ?? "manager";
    return {
      fromAgent,
      fromSessionId:
        firstString(body.from_session_id, body.fromSessionId) ??
        (fromAgent === "manager" ? "manager-system" : "agent-session-unknown"),
      messageType: body.message_type ?? body.messageType ?? "MANAGER_MESSAGE",
      toRole: firstString(body.to?.agent, body.to?.role, body.to_role, body.toRole),
      toSessionId: firstString(body.to?.session_id, body.to?.sessionId, body.to_session_id, body.toSessionId),
      taskId: firstString(body.task_id, body.taskId),
      requestId: firstString(body.request_id, body.requestId),
      parentRequestId: firstString(body.parent_request_id, body.parentRequestId),
      content: body.content,
      discuss: body.discuss
        ? {
            threadId: firstString(body.discuss.thread_id, body.discuss.threadId),
            requestId: firstString(body.discuss.request_id, body.discuss.requestId)
          }
        : undefined
    };
  });

export type WorkflowMessageSendRequestContract = z.infer<typeof WorkflowMessageSendRequestSchema>;
export const WorkflowMessageSendPublicRequestSchema = z.object({
  from_agent: optionalString,
  from_session_id: optionalString,
  message_type: WorkflowMessageTypeSchema.optional(),
  to_role: optionalString,
  to_session_id: optionalString,
  to: z
    .object({
      agent: optionalString,
      role: optionalString,
      session_id: optionalString,
      sessionId: optionalString
    })
    .optional(),
  task_id: optionalString,
  request_id: optionalString,
  parent_request_id: optionalString,
  content: requiredString,
  discuss: z
    .object({
      thread_id: optionalString,
      request_id: optionalString
    })
    .optional()
});
export type WorkflowMessageSendPublicRequest = z.infer<typeof WorkflowMessageSendPublicRequestSchema>;

export const WorkflowMessageRoutedPayloadSchema = z.object({
  fromAgent: z.string(),
  toRole: z.string().nullable(),
  resolvedSessionId: z.string(),
  requestId: z.string(),
  messageId: z.string(),
  content: z.string(),
  messageType: z.string(),
  discuss: z.unknown().nullable(),
  sourceType: z.string(),
  originAgent: z.string()
});

export type WorkflowMessageRoutedPayloadContract = z.infer<typeof WorkflowMessageRoutedPayloadSchema>;

export const TeamToolNameSchema = z.enum([
  "task_create_assign",
  "task_report_in_progress",
  "task_report_done",
  "task_report_block",
  "discuss_request",
  "discuss_reply",
  "discuss_close",
  "route_targets_get",
  "lock_manage"
]);

export const TeamToolErrorPayloadSchema = z.object({
  error_code: z.string(),
  message: z.string(),
  recoverable: z.boolean().optional(),
  next_action: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional()
});

export type TeamToolErrorPayloadContract = z.infer<typeof TeamToolErrorPayloadSchema>;
