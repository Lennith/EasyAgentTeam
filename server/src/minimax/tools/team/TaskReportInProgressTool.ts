import { TeamTool } from "./TeamTool.js";

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class TaskReportInProgressTool extends TeamTool {
  get name(): string {
    return "task_report_in_progress";
  }

  get description(): string {
    return "Report in-progress task update (PARTIAL) with concise status.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id. Defaults to active task context." },
        content: { type: "string", description: "Current progress summary." },
        progress_file: { type: "string", description: "Optional progress file path." }
      },
      required: ["content"]
    };
  }

  protected async executeWithContext(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const taskId = this.resolveTaskId(args.task_id);
    const content = readString(args.content);
    if (!taskId) {
      throw new Error("task_id is required when no active task context exists");
    }
    if (!content) {
      throw new Error("content is required");
    }
    const payload: Record<string, unknown> = {
      action_type: "TASK_REPORT",
      from_agent: this.context.agentRole,
      from_session_id: this.context.sessionId,
      parent_request_id: this.context.parentRequestId ?? null,
      task_id: taskId,
      report_mode: "IN_PROGRESS",
      report_content: content,
      report_file: readString(args.progress_file) ?? null
    };
    const result = await this.bridge.taskAction(payload);
    return {
      action_type: "TASK_REPORT",
      report_mode: "IN_PROGRESS",
      task_id: taskId,
      result
    };
  }
}
