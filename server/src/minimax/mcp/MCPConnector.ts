import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Tool, successResult, errorResult } from "../tools/Tool.js";
import type { ToolResult, MCPServerConfig } from "../types.js";
import { logger } from "../../utils/logger.js";

export interface MCPToolOptions {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  client: Client;
  timeout?: number;
}

export class MCPTool extends Tool {
  private _name: string;
  private _description: string;
  private _parameters: Record<string, unknown>;
  private client: Client;
  private timeout: number;

  constructor(options: MCPToolOptions) {
    super();
    this._name = options.name;
    this._description = options.description;
    this._parameters = options.parameters;
    this.client = options.client;
    this.timeout = options.timeout ?? 60000;
  }

  get name(): string {
    return this._name;
  }

  get description(): string {
    return this._description;
  }

  get parameters(): Record<string, unknown> {
    return this._parameters;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = await Promise.race([
        this.client.callTool({ name: this._name, arguments: args }),
        this.createTimeout(this.timeout)
      ]);

      const content = this.extractContent(result);
      const isError = result.isError ?? false;

      if (isError) {
        return errorResult(content);
      }
      return successResult(content);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return errorResult(`MCP tool execution failed: ${errorMessage}`);
    }
  }

  private extractContent(result: any): string {
    if (!result.content) {
      return "";
    }

    const parts: string[] = [];
    for (const item of result.content) {
      if (item.type === "text") {
        parts.push(item.text);
      } else {
        parts.push(JSON.stringify(item));
      }
    }
    return parts.join("\n");
  }

  private createTimeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    });
  }
}

export interface MCPServerConnection {
  name: string;
  config: MCPServerConfig;
  client: Client | null;
  transport: Transport | null;
  tools: MCPTool[];
}

export class MCPConnector {
  private connections: Map<string, MCPServerConnection> = new Map();
  private defaultTimeout: number;

  constructor(defaultTimeout: number = 60000) {
    this.defaultTimeout = defaultTimeout;
  }

  async connect(config: MCPServerConfig): Promise<MCPTool[]> {
    if (config.disabled) {
      logger.info(`MCP server "${config.name}" is disabled, skipping`);
      return [];
    }

    try {
      const transport = await this.createTransport(config);
      const client = new Client({ name: "minimax-agent", version: "1.0.0" }, { capabilities: {} });

      await client.connect(transport);

      const toolsResult = await client.listTools();
      const tools: MCPTool[] = [];

      for (const tool of toolsResult.tools) {
        const mcpTool = new MCPTool({
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.inputSchema as Record<string, unknown>,
          client,
          timeout: config.executeTimeout ?? this.defaultTimeout
        });
        tools.push(mcpTool);
      }

      this.connections.set(config.name, {
        name: config.name,
        config,
        client,
        transport,
        tools
      });

      logger.info(`Connected to MCP server "${config.name}" - loaded ${tools.length} tools`);
      return tools;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to connect to MCP server "${config.name}": ${errorMessage}`);
      return [];
    }
  }

  private async createTransport(config: MCPServerConfig): Promise<Transport> {
    if (config.type === "stdio") {
      if (!config.command) {
        throw new Error("Command is required for stdio MCP server");
      }
      return new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env ?? ({ ...process.env } as Record<string, string>)
      });
    }

    if (config.type === "sse" && config.url) {
      return new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
    }

    throw new Error(`Unsupported MCP server type: ${config.type}`);
  }

  async connectAll(servers: MCPServerConfig[]): Promise<MCPTool[]> {
    const allTools: MCPTool[] = [];

    for (const server of servers) {
      const tools = await this.connect(server);
      allTools.push(...tools);
    }

    return allTools;
  }

  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (conn?.client) {
      await conn.client.close();
    }
    this.connections.delete(name);
  }

  async disconnectAll(): Promise<void> {
    for (const [name] of this.connections) {
      await this.disconnect(name);
    }
  }

  getConnection(name: string): MCPServerConnection | undefined {
    return this.connections.get(name);
  }

  getAllTools(): MCPTool[] {
    const tools: MCPTool[] = [];
    for (const conn of this.connections.values()) {
      tools.push(...conn.tools);
    }
    return tools;
  }
}

export function createMCPConnector(defaultTimeout?: number): MCPConnector {
  return new MCPConnector(defaultTimeout);
}
