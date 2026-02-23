import { TeamTool } from "./TeamTool.js";

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class RouteTargetsTool extends TeamTool {
  get name(): string {
    return "route_targets_get";
  }

  get description(): string {
    return "Get available route targets and discuss limits for current role.";
  }

  get parameters(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        from_agent: { type: "string", description: "Source role. Defaults to current role." }
      },
      required: []
    };
  }

  protected async executeWithContext(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fromAgent = readString(args.from_agent) ?? this.context.agentRole;
    const result = await this.bridge.getRouteTargets(fromAgent);
    return {
      from_agent: fromAgent,
      result
    };
  }
}
