import { TeamTool } from "./TeamTool.js";

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class TaskReportBlockTool extends TeamTool {
  get name(): string {
    return "task_report_block";
  }

  get description(): string {
    return "Report task blocker (BLOCK) with concrete blocker reason.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id. Defaults to active task context." },
        block_reason: { type: "string", description: "Concrete blocker reason and what is needed." },
        progress_file: { type: "string", description: "Optional progress file path." }
      },
      required: ["block_reason"]
    };
  }

  protected async executeWithContext(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const taskId = this.resolveTaskId(args.task_id);
    const blockReason = readString(args.block_reason);
    if (!taskId) {
      throw new Error("task_id is required when no active task context exists");
    }
    if (!blockReason) {
      throw new Error("block_reason is required");
    }
    const payload: Record<string, unknown> = {
      action_type: "TASK_REPORT",
      from_agent: this.context.agentRole,
      from_session_id: this.context.sessionId,
      parent_request_id: this.context.parentRequestId ?? null,
      task_id: taskId,
      report_mode: "BLOCK",
      report_content: blockReason,
      report_file: readString(args.progress_file) ?? null
    };
    const result = await this.bridge.taskAction(payload);
    return {
      action_type: "TASK_REPORT",
      report_mode: "BLOCK",
      task_id: taskId,
      result
    };
  }
}
