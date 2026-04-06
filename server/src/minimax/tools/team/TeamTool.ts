import { appendEvent } from "../../../data/repository/project/event-repository.js";
import { Tool, errorResult, successResult } from "../Tool.js";
import type { TeamToolBridge, TeamToolErrorPayload, TeamToolExecutionContext } from "./types.js";
import { TeamToolBridgeError } from "../../../services/minimax-teamtool-bridge.js";
import type { ToolResult } from "../../types.js";

function safeStringify(value: unknown, maxLength: number = 4000): string {
  try {
    const raw = JSON.stringify(value, null, 2);
    if (raw.length <= maxLength) {
      return raw;
    }
    return `${raw.slice(0, maxLength)}\n...<truncated>`;
  } catch {
    return String(value);
  }
}

export abstract class TeamTool extends Tool {
  protected readonly context: TeamToolExecutionContext;
  protected readonly bridge: TeamToolBridge;

  constructor(context: TeamToolExecutionContext, bridge: TeamToolBridge) {
    super();
    this.context = context;
    this.bridge = bridge;
  }

  protected abstract executeWithContext(args: Record<string, unknown>): Promise<Record<string, unknown>>;

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    await this.emit("TEAM_TOOL_CALLED", {
      tool: this.name,
      args
    });
    try {
      const data = await this.executeWithContext(args);
      await this.emit("TEAM_TOOL_SUCCEEDED", {
        tool: this.name,
        result: data
      });
      return successResult(safeStringify(data));
    } catch (error) {
      const payload = this.normalizeErrorPayload(error);
      await this.emit("TEAM_TOOL_FAILED", {
        tool: this.name,
        error: payload
      });
      return errorResult(safeStringify(payload));
    }
  }

  protected resolveTaskId(candidate: unknown): string | undefined {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
    return this.context.activeTaskId;
  }

  protected parseStringList(input: unknown): string[] {
    if (Array.isArray(input)) {
      return input.map((item) => String(item).trim()).filter((item) => item.length > 0);
    }
    if (typeof input === "string") {
      return input
        .split(/[,\n\r|]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
    return [];
  }

  private normalizeErrorPayload(error: unknown): TeamToolErrorPayload {
    if (error instanceof TeamToolBridgeError) {
      return {
        error_code: error.code,
        message: error.message,
        next_action: error.nextAction,
        raw: error.raw
      };
    }
    if (error instanceof Error) {
      return {
        error_code: "TEAM_TOOL_UNEXPECTED_ERROR",
        message: error.message,
        next_action: "Retry once. If persistent, report blocker with exact error.",
        raw: null
      };
    }
    return {
      error_code: "TEAM_TOOL_UNEXPECTED_ERROR",
      message: String(error),
      next_action: "Retry once. If persistent, report blocker with exact error.",
      raw: null
    };
  }

  private async emit(eventType: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await appendEvent(this.context.paths, {
        projectId: this.context.project.projectId,
        eventType,
        source: "agent",
        sessionId: this.context.sessionId,
        taskId: this.context.activeTaskId,
        payload
      });
    } catch {
      // best effort only
    }
  }
}
