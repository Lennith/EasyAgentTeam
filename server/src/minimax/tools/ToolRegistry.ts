import type { ToolSchema, ToolResult } from "../types.js";
import { Tool } from "./Tool.js";

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  getSchemas(): ToolSchema[] {
    return this.getAll().map((tool) => tool.toSchema());
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, content: "", error: `Unknown tool: ${name}` };
    }

    try {
      return await tool.execute(args);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, content: "", error: `Tool execution failed: ${errorMessage}` };
    }
  }

  clear(): void {
    this.tools.clear();
  }

  get size(): number {
    return this.tools.size;
  }
}
