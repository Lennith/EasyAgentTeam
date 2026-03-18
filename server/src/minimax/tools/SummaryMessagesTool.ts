import { Tool, errorResult, successResult } from "./Tool.js";
import type { SummaryApplyRequest, SummaryCheckpoint, ToolResult } from "../types.js";

export interface SummaryMessagesBridge {
  isDisabled(): boolean;
  listCheckpoints(limit: number): SummaryCheckpoint[];
  enqueueApply(request: SummaryApplyRequest): {
    accepted: boolean;
    availableCheckpoints: number;
  };
}

export interface SummaryMessagesToolOptions {
  bridge: SummaryMessagesBridge;
}

function toInteger(value: unknown, fallback: number): number {
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

export class SummaryMessagesTool extends Tool {
  private readonly bridge: SummaryMessagesBridge;

  constructor(options: SummaryMessagesToolOptions) {
    super();
    this.bridge = options.bridge;
  }

  get name(): string {
    return "summary_messages";
  }

  get description(): string {
    return (
      "Reset noisy conversation context to an earlier checkpoint while keeping filesystem/runtime state unchanged. " +
      "Use when context is cluttered by irrelevant history, large file/search outputs, or failed exploration steps. " +
      "Typical flow: action=list to inspect checkpoints, then action=apply with checkpoint_id + concise summary " +
      "to keep only useful progress and next steps."
    );
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "apply"],
          description:
            "list: inspect available checkpoints. apply: compact context from checkpoint_id with summary for continuation."
        },
        checkpoint_id: {
          type: "string",
          description: "Existing checkpoint id returned by action=list. Required when action=apply."
        },
        summary: {
          type: "string",
          description:
            "Concise carry-forward note (what changed, key findings, next steps). Required when action=apply."
        },
        keep_recent_messages: {
          type: "number",
          description:
            "Number of newest messages to keep in addition to checkpoint prefix and summary anchor. Range 0~20. Default 0."
        },
        limit: {
          type: "number",
          description: "Max checkpoint count for action=list. Range 1~200. Default 50."
        }
      },
      required: ["action"]
    };
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    if (this.bridge.isDisabled()) {
      return errorResult(
        JSON.stringify(
          {
            error_code: "SUMMARY_APPLY_NOT_AVAILABLE",
            message: "summary_messages is disabled by runtime switch AUTO_DEV_SUMMARY_MESSAGES_DISABLE=1"
          },
          null,
          2
        )
      );
    }

    const action = String(args.action ?? "")
      .trim()
      .toLowerCase();
    if (action === "list") {
      const limitRaw = toInteger(args.limit, 50);
      const limit = Math.min(200, Math.max(1, limitRaw));
      const checkpoints = this.bridge.listCheckpoints(limit);
      return successResult(
        JSON.stringify(
          {
            ok: true,
            action: "list",
            total: checkpoints.length,
            checkpoints
          },
          null,
          2
        )
      );
    }

    if (action === "apply") {
      const checkpointId = String(args.checkpoint_id ?? "").trim();
      const summary = String(args.summary ?? "").trim();
      const keepRecentRaw = toInteger(args.keep_recent_messages, 0);
      if (!checkpointId) {
        return errorResult(
          JSON.stringify(
            {
              error_code: "CHECKPOINT_NOT_FOUND",
              message: "checkpoint_id is required for action=apply"
            },
            null,
            2
          )
        );
      }
      if (!summary) {
        return errorResult(
          JSON.stringify(
            {
              error_code: "SUMMARY_EMPTY",
              message: "summary is required for action=apply"
            },
            null,
            2
          )
        );
      }
      if (!Number.isFinite(keepRecentRaw) || keepRecentRaw < 0 || keepRecentRaw > 20) {
        return errorResult(
          JSON.stringify(
            {
              error_code: "INVALID_KEEP_RECENT_MESSAGES",
              message: "keep_recent_messages must be an integer in range 0~20"
            },
            null,
            2
          )
        );
      }

      const checkpoints = this.bridge.listCheckpoints(1000);
      const found = checkpoints.find((item) => item.checkpointId === checkpointId);
      if (!found) {
        return errorResult(
          JSON.stringify(
            {
              error_code: "CHECKPOINT_NOT_FOUND",
              message: `checkpoint '${checkpointId}' not found`
            },
            null,
            2
          )
        );
      }

      const result = this.bridge.enqueueApply({
        checkpointId,
        summary,
        keepRecentMessages: keepRecentRaw,
        requestedAt: new Date().toISOString()
      });

      return successResult(
        JSON.stringify(
          {
            ok: result.accepted,
            action: "apply",
            accepted: result.accepted,
            checkpoint_id: checkpointId,
            keep_recent_messages: keepRecentRaw,
            summary_chars: summary.length,
            available_checkpoints: result.availableCheckpoints
          },
          null,
          2
        )
      );
    }

    return errorResult(`Unknown action: ${action}`);
  }
}

export function createSummaryMessagesTool(options: SummaryMessagesToolOptions): SummaryMessagesTool {
  return new SummaryMessagesTool(options);
}
