import type { ToolResult, ToolSchema } from "../types.js";

export abstract class Tool {
  abstract get name(): string;
  abstract get description(): string;
  abstract get parameters(): Record<string, unknown>;

  abstract execute(args: Record<string, unknown>): Promise<ToolResult>;

  toSchema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.parameters
    };
  }
}

export function createToolSchema(name: string, description: string, parameters: Record<string, unknown>): ToolSchema {
  return { name, description, inputSchema: parameters };
}

export function successResult(content: string): ToolResult {
  return { success: true, content };
}

export function errorResult(error: string): ToolResult {
  return { success: false, content: "", error };
}
