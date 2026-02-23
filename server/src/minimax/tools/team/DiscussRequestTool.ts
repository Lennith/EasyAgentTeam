import { TeamTool } from "./TeamTool.js";

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInteger(value: unknown, fallback: number = 1): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.floor(parsed));
    }
  }
  return fallback;
}

export class DiscussRequestTool extends TeamTool {
  get name(): string {
    return "discuss_request";
  }

  get description(): string {
    return "Send task discuss request to target role through manager-routed channel.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        to_role: { type: "string", description: "Target role." },
        message: { type: "string", description: "Discuss request content." },
        task_id: { type: "string", description: "Task id. Defaults to active task context." },
        thread_id: { type: "string", description: "Discuss thread id." },
        round: { type: "number", description: "Discuss round index." }
      },
      required: ["to_role", "message"]
    };
  }

  protected async executeWithContext(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const toRole = readString(args.to_role);
    const message = readString(args.message);
    const taskId = this.resolveTaskId(args.task_id);
    if (!toRole) {
      throw new Error("to_role is required");
    }
    if (!message) {
      throw new Error("message is required");
    }
    if (!taskId) {
      throw new Error("task_id is required when no active task context exists");
    }
    const threadId = readString(args.thread_id) ?? `${taskId}-${Date.now()}`;
    const payload: Record<string, unknown> = {
      from_agent: this.context.agentRole,
      from_session_id: this.context.sessionId,
      to: { agent: toRole },
      content: message,
      mode: "CHAT",
      message_type: "TASK_DISCUSS_REQUEST",
      task_id: taskId,
      parent_request_id: this.context.parentRequestId ?? null,
      discuss: {
        thread_id: threadId,
        round: readInteger(args.round, 1)
      }
    };
    const result = await this.bridge.sendMessage(payload);
    return {
      message_type: "TASK_DISCUSS_REQUEST",
      task_id: taskId,
      to_role: toRole,
      thread_id: threadId,
      result
    };
  }
}
