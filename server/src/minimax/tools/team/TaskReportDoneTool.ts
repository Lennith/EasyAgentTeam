import fs from "node:fs/promises";
import { TeamTool } from "./TeamTool.js";

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function loadReportContent(pathValue: string | undefined, directContent: string | undefined): Promise<string> {
  if (directContent) {
    return directContent;
  }
  if (!pathValue) {
    throw new Error("task_report or task_report_path is required");
  }
  const raw = await fs.readFile(pathValue, "utf8");
  const normalized = raw.trim();
  if (!normalized) {
    throw new Error("task_report_path is empty");
  }
  return normalized;
}

export class TaskReportDoneTool extends TeamTool {
  get name(): string {
    return "task_report_done";
  }

  get description(): string {
    return "Report task completion (DONE) with evidence summary.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task id. Defaults to active task context." },
        task_report: { type: "string", description: "Inline report content." },
        task_report_path: { type: "string", description: "Path to report markdown/text/json file." }
      },
      required: []
    };
  }

  protected async executeWithContext(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const taskId = this.resolveTaskId(args.task_id);
    if (!taskId) {
      throw new Error("task_id is required when no active task context exists");
    }
    const reportPath = readString(args.task_report_path);
    const reportContent = await loadReportContent(reportPath, readString(args.task_report));
    const payload: Record<string, unknown> = {
      action_type: "TASK_REPORT",
      from_agent: this.context.agentRole,
      from_session_id: this.context.sessionId,
      parent_request_id: this.context.parentRequestId ?? null,
      summary: reportContent,
      results: [
        {
          task_id: taskId,
          outcome: "DONE",
          summary: reportContent,
          artifacts: reportPath ? [reportPath] : []
        }
      ]
    };
    const result = await this.bridge.taskAction(payload);
    return {
      action_type: "TASK_REPORT",
      outcome: "DONE",
      task_id: taskId,
      result
    };
  }
}
