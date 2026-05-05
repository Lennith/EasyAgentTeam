import { z } from "zod";
import { optionalString, requiredString, stringArrayFromArrayOrString } from "./common.js";

const TeamToolNameLocalSchema = z.enum([
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

const TaskCreateAssignInputSchema = z.object({
  task_id: optionalString,
  title: requiredString,
  to_role: requiredString,
  parent_task_id: optionalString,
  dependencies: stringArrayFromArrayOrString,
  acceptance: stringArrayFromArrayOrString,
  write_set: stringArrayFromArrayOrString,
  artifacts: stringArrayFromArrayOrString
});

const TaskReportInProgressInputSchema = z.object({
  task_id: optionalString,
  content: requiredString,
  progress_file: optionalString
});

const TaskReportDoneInputSchema = z
  .object({
    task_id: optionalString,
    task_report: optionalString,
    task_report_path: optionalString
  })
  .superRefine((body, ctx) => {
    if (!body.task_report && !body.task_report_path) {
      ctx.addIssue({ code: "custom", message: "task_report or task_report_path is required" });
    }
  });

const TaskReportBlockInputSchema = z.object({
  task_id: optionalString,
  block_reason: requiredString,
  progress_file: optionalString
});

const DiscussInputSchema = z.object({
  task_id: optionalString,
  to_role: optionalString,
  message: requiredString,
  thread_id: optionalString,
  request_id: optionalString,
  parent_request_id: optionalString,
  in_reply_to: optionalString
});

const RouteTargetsInputSchema = z.object({
  from_agent: optionalString
});

const LockManageInputSchema = z.object({
  action: z.enum(["acquire", "renew", "release", "list"]),
  lock_key: optionalString,
  ttl_seconds: z.number().int().positive().optional(),
  target_type: z.enum(["file", "dir"]).optional(),
  purpose: optionalString
});

export const TeamToolInputPayloadSchema = z
  .object({
    tool: TeamToolNameLocalSchema,
    input: z.record(z.string(), z.unknown()).optional()
  })
  .superRefine((body, ctx) => {
    const input = body.input ?? {};
    const schema =
      body.tool === "task_create_assign"
        ? TaskCreateAssignInputSchema
        : body.tool === "task_report_in_progress"
          ? TaskReportInProgressInputSchema
          : body.tool === "task_report_done"
            ? TaskReportDoneInputSchema
            : body.tool === "task_report_block"
              ? TaskReportBlockInputSchema
              : body.tool === "discuss_request" || body.tool === "discuss_reply" || body.tool === "discuss_close"
                ? DiscussInputSchema
                : body.tool === "route_targets_get"
                  ? RouteTargetsInputSchema
                  : LockManageInputSchema;
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ ...issue, path: ["input", ...issue.path] });
      }
    }
  });

export type TeamToolInputPayload = z.infer<typeof TeamToolInputPayloadSchema>;
