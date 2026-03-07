import { TeamTool } from "./TeamTool.js";

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

export class LockManageTool extends TeamTool {
  get name(): string {
    return "lock_manage";
  }

  get description(): string {
    return "Acquire/renew/release/list workspace file locks. Use target_type=dir only when a directory lock is truly required.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        action: { type: "string", enum: ["acquire", "renew", "release", "list"] },
        lock_key: { type: "string", description: "Workspace-relative file/dir path key." },
        target_type: {
          type: "string",
          enum: ["file", "dir"],
          description: "Optional. Defaults to file; set dir explicitly for directory lock."
        },
        ttl_seconds: { type: "number", description: "Lock ttl seconds (acquire)." },
        purpose: { type: "string", description: "Optional lock purpose note." },
        session_id: { type: "string", description: "Optional explicit session id." }
      },
      required: ["action"]
    };
  }

  protected async executeWithContext(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = (readString(args.action) ?? "").toLowerCase();
    if (action === "list") {
      const result = await this.bridge.lockList();
      return { action, result };
    }

    const payload: Record<string, unknown> = {
      session_id: readString(args.session_id) ?? this.context.sessionId,
      lock_key: readString(args.lock_key),
      target_type: readString(args.target_type),
      ttl_seconds: readInteger(args.ttl_seconds),
      purpose: readString(args.purpose)
    };

    if (action === "acquire") {
      const result = await this.bridge.lockAcquire(payload);
      return { action, result };
    }
    if (action === "renew") {
      const result = await this.bridge.lockRenew(payload);
      return { action, result };
    }
    if (action === "release") {
      const result = await this.bridge.lockRelease(payload);
      return { action, result };
    }
    throw new Error("action must be acquire|renew|release|list");
  }
}
