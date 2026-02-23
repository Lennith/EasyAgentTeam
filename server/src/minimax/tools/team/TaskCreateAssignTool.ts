import { randomUUID } from "node:crypto";
import { TeamTool } from "./TeamTool.js";

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInteger(value: unknown, fallback: number = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return fallback;
}

function buildTaskId(agentRole: string, ownerRole: string): string {
  const ts = Date.now();
  const rand = randomUUID().replace(/-/g, "").slice(0, 6);
  return `task-${ts}-${agentRole}-to-${ownerRole}-${rand}`;
}

export class TaskCreateAssignTool extends TeamTool {
  get name(): string {
    return "task_create_assign";
  }

  get description(): string {
    return "Create a task and assign it to target role in one action.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        title: { type: "string", description: "Short executable task title." },
        to_role: { type: "string", description: "Target owner role." },
        task_id: { type: "string", description: "Optional explicit task id." },
        parent_task_id: { type: "string", description: "Parent task id. Defaults to active task." },
        root_task_id: { type: "string", description: "Optional root task id. Defaults to active root." },
        priority: { type: "number", description: "Task priority, default 0." },
        dependencies: { type: ["array", "string"], description: "Dependency task ids." },
        write_set: { type: ["array", "string"], description: "Files intended to modify." },
        acceptance: { type: ["array", "string"], description: "Acceptance criteria list." },
        artifacts: { type: ["array", "string"], description: "Related docs or artifacts paths." },
        content: { type: "string", description: "Optional brief context." }
      },
      required: ["title", "to_role"]
    };
  }

  protected async executeWithContext(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const title = readString(args.title);
    const ownerRole = readString(args.to_role);
    if (!title) {
      throw new Error("title is required");
    }
    if (!ownerRole) {
      throw new Error("to_role is required");
    }
    const taskId = readString(args.task_id) ?? buildTaskId(this.context.agentRole, ownerRole);
    const parentTaskId = readString(args.parent_task_id) ?? this.context.activeTaskId;
    if (!parentTaskId) {
      throw new Error("parent_task_id is required when no active task context exists");
    }
    const rootTaskId = readString(args.root_task_id) ?? this.context.activeRootTaskId;
    const payload: Record<string, unknown> = {
      action_type: "TASK_CREATE",
      from_agent: this.context.agentRole,
      from_session_id: this.context.sessionId,
      parent_request_id: this.context.parentRequestId ?? null,
      task_id: taskId,
      task_kind: "EXECUTION",
      parent_task_id: parentTaskId,
      root_task_id: rootTaskId ?? null,
      title,
      owner_role: ownerRole,
      priority: readInteger(args.priority, 0),
      dependencies: this.parseStringList(args.dependencies),
      write_set: this.parseStringList(args.write_set),
      acceptance: this.parseStringList(args.acceptance),
      artifacts: this.parseStringList(args.artifacts),
      content: readString(args.content) ?? null
    };
    const result = await this.bridge.taskAction(payload);
    return {
      action_type: "TASK_CREATE",
      task_id: taskId,
      owner_role: ownerRole,
      result
    };
  }
}
