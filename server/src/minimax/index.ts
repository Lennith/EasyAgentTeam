import * as path from "path";
import * as crypto from "crypto";
import { logger } from "../utils/logger.js";
import { LLMClient, trimMessagesForContextWindow } from "./llm/LLMClient.js";
import { Agent } from "./agent/Agent.js";
import {
  Tool,
  ToolRegistry,
  createFileTools,
  createShellTool,
  createNoteTool,
  PermissionManager,
  createTeamTools,
  createToolRegistrationState,
  registerToolWithDedupe,
  resolveToolCapabilityFamily
} from "./tools/index.js";
import { MCPConnector } from "./mcp/MCPConnector.js";
import { SessionStorage } from "./storage/SessionStorage.js";
import { ContextCompressor } from "./compression/ContextCompressor.js";
import { getRuntimePlatformCapabilities } from "../runtime-platform.js";
import type {
  MiniMaxRunOptions,
  MiniMaxRunResult,
  AgentCallback,
  MCPServerConfig,
  Session,
  Message,
  SessionStorageConfig,
  MiniMaxAgentConfig
} from "./types.js";

export interface MiniMaxAgentOptions {
  config: MiniMaxAgentConfig;
  storageConfig?: SessionStorageConfig;
}

function normalizeMaxOutputTokens(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}

function buildDefaultSystemPrompt(): string {
  const runtime = getRuntimePlatformCapabilities();
  const shellNames = runtime.platform === "win32" ? "cmd.exe or PowerShell" : "bash or sh";
  const commandGuidance =
    runtime.platform === "win32"
      ? [
          "- Use Windows command syntax (dir, type, copy, move, del, findstr)",
          "- Use Windows path format (C:\\path\\to\\file)",
          "- Prefer .bat or .ps1 for scripts"
        ]
      : [
          "- Use POSIX shell commands (ls, cat, cp, mv, rm, grep, find)",
          "- Use POSIX path format (/path/to/file)",
          "- Prefer .sh scripts or direct shell commands"
        ];
  const guidelines =
    runtime.platform === "win32"
      ? [
          "1. Always assume Windows execution environment",
          "2. Never produce Unix-style commands even if they appear shorter",
          "3. Always verify file paths before operations",
          "4. Use Windows-compatible command syntax",
          "5. Prefer PowerShell for complex operations",
          "6. Provide clear explanations of your actions",
          "7. Ask for clarification when needed"
        ]
      : [
          "1. Always assume POSIX execution environment",
          "2. Never produce PowerShell/CMD commands",
          "3. Always verify file paths before operations",
          "4. Use bash/sh-compatible syntax",
          "5. Prefer bash for complex operations and sh for fallback compatibility",
          "6. Provide clear explanations of your actions",
          "7. Ask for clarification when needed"
        ];

  return [
    "You are a helpful AI assistant with access to file system tools and shell commands.",
    `## Runtime (${runtime.label}${runtime.macosUntested ? ", design-compatible" : ""})`,
    `- OS: ${runtime.label}`,
    `- Shell: ${shellNames}`,
    ...runtime.promptBaseline.split("\n"),
    "",
    "## Command Rules",
    "- Execute ONE command per step",
    "- NEVER use &&, ||, ;, or command chaining",
    "- Do not assume previous command success",
    ...commandGuidance,
    "",
    "## Capabilities",
    "- Read, write, and edit files",
    `- Execute ${runtime.platform === "win32" ? "Windows" : "POSIX"} shell commands`,
    "- Take and manage notes",
    "",
    "## TeamWorkSpace Context",
    "- TeamWorkSpace: The shared project directory (../../ from your workspace)",
    "- Your Workspace: Your personal working directory (current directory)",
    "- Shared docs/planning deliverables: <TeamWorkSpace>/docs/**",
    "- Shared implementation source code: <TeamWorkSpace>/src/**",
    "",
    "## Startup Checklist",
    "Read `./AGENTS.md` first for runtime rules and team coordination.",
    "",
    "## Guidelines",
    ...guidelines
  ].join("\n");
}

export class MiniMaxAgent {
  private config: MiniMaxAgentConfig;
  private llmClient: LLMClient | null = null;
  private agent: Agent | null = null;
  private toolRegistry: ToolRegistry | null = null;
  private permissionManager: PermissionManager | null = null;
  private mcpConnector: MCPConnector | null = null;
  private storage: SessionStorage;
  private compressor: ContextCompressor | null = null;
  private sessionDir: string;

  constructor(options: MiniMaxAgentOptions) {
    this.config = options.config;

    this.sessionDir = this.config.sessionDir ?? path.join(this.config.workspaceDir, ".minimax", "sessions");

    logger.info(`[MiniMaxAgent] config.sessionDir: ${this.config.sessionDir ?? "(not set)"}`);
    logger.info(`[MiniMaxAgent] resolved sessionDir: ${this.sessionDir}`);
    logger.info(`[MiniMaxAgent] workspaceDir: ${this.config.workspaceDir}`);

    this.storage = new SessionStorage(this.config.workspaceDir, options.storageConfig, this.sessionDir);
  }

  private generateSessionId(): string {
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString("hex");
    return `sess-${timestamp}-${random}`;
  }

  private isValidSessionId(sessionId: string): boolean {
    return /^sess-\d+-[a-f0-9]{8}$/.test(sessionId) || /^[a-zA-Z0-9_-]+$/.test(sessionId);
  }

  async initialize(callback?: AgentCallback): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error("API key is required. Set it via config.");
    }

    this.llmClient = new LLMClient({
      apiKey: this.config.apiKey,
      apiBase: this.config.apiBase,
      model: this.config.model,
      maxTokens: normalizeMaxOutputTokens(this.config.maxOutputTokens)
    });

    this.compressor = new ContextCompressor(this.llmClient, 0.3);

    this.permissionManager = new PermissionManager({
      workspaceDir: this.config.workspaceDir,
      additionalWritableDirs: this.config.additionalWritableDirs ?? []
    });

    this.toolRegistry = new ToolRegistry();
    const registrationState = createToolRegistrationState();
    const registerTool = (tool: Tool, source: "team" | "core" | "other") => {
      const result = registerToolWithDedupe(this.toolRegistry!, registrationState, tool, source);
      if (result.skipped) {
        logger.warn(
          `[MINIMAX_TOOL_REGISTRATION_SKIPPED_DUPLICATE] tool=${result.toolName} capability=${result.capability} kept_tool=${result.keptToolName ?? "none"} source=${source} reason=${result.reason}`
        );
        return;
      }
      if (result.replaced) {
        logger.info(
          `[MINIMAX_TOOL_REGISTRATION_REPLACED] tool=${tool.name} capability=${resolveToolCapabilityFamily(tool.name)} replaced_tool=${result.replaced.toolName} replaced_source=${result.replaced.source} source=${source}`
        );
      }
    };

    if (this.config.enableFileTools) {
      const fileTools = createFileTools({
        workspaceDir: this.config.workspaceDir,
        checkPermission: this.permissionManager.createPermissionChecker()
      });
      for (const tool of fileTools) {
        if (tool.name === "list_directory") {
          continue;
        }
        registerTool(tool, "core");
      }
    }

    if (this.config.enableShell) {
      const shellLogDir = this.config.shellLogDir ?? path.join(this.sessionDir, "shell-logs");
      const shellTool = createShellTool({
        workspaceDir: this.config.workspaceDir,
        shell: this.config.shellType,
        timeout: this.config.shellTimeout,
        outputIdleTimeout: this.config.shellOutputIdleTimeout,
        maxRunTime: this.config.shellMaxRunTime,
        maxOutputSize: this.config.shellMaxOutputSize,
        logDir: shellLogDir,
        checkPermission: this.permissionManager.createPermissionChecker(),
        env: this.config.env
      });
      registerTool(shellTool, "core");
    }

    if (this.config.enableNote) {
      const noteTool = createNoteTool({
        workspaceDir: this.config.workspaceDir
      });
      registerTool(noteTool, "core");
    }

    if (this.config.teamToolContext && this.config.teamToolBridge) {
      const teamTools = createTeamTools({
        context: this.config.teamToolContext,
        bridge: this.config.teamToolBridge
      });
      for (const tool of teamTools) {
        registerTool(tool, "team");
      }
    }

    if (this.config.mcpEnabled && this.config.mcpServers && this.config.mcpServers.length > 0) {
      this.mcpConnector = new MCPConnector(this.config.mcpExecuteTimeout);
      const mcpTools = await this.mcpConnector.connectAll(this.config.mcpServers);
      for (const tool of mcpTools) {
        registerTool(tool, "other");
      }
    }

    const systemPrompt = this.config.systemPrompt?.trim() || buildDefaultSystemPrompt();

    let mcpToolDescriptions = "";
    if (this.mcpConnector) {
      const mcpTools = this.mcpConnector.getAllTools();
      if (mcpTools.length > 0) {
        mcpToolDescriptions = mcpTools.map((tool) => `- **${tool.name}**: ${tool.description}`).join("\n");
      }
    }

    this.agent = new Agent({
      llmClient: this.llmClient,
      toolRegistry: this.toolRegistry,
      systemPrompt,
      maxSteps: this.config.maxSteps,
      tokenLimit: this.config.tokenLimit,
      workspaceDir: this.config.workspaceDir,
      callback,
      mcpToolDescriptions
    });
  }

  async run(options: MiniMaxRunOptions): Promise<string> {
    const result = await this.runWithResult(options);
    return result.content;
  }

  async runWithResult(options: MiniMaxRunOptions): Promise<MiniMaxRunResult> {
    logger.info(`[MiniMaxAgent] runWithResult called with options.sessionId=${options.sessionId}`);

    if (!this.agent || !this.llmClient || !this.compressor) {
      await this.initialize(options.callback);
    }

    if (!this.agent || !this.llmClient || !this.compressor) {
      throw new Error("Failed to initialize agent");
    }

    let sessionId = options.sessionId;
    let isNewSession = false;

    if (sessionId) {
      if (!this.isValidSessionId(sessionId)) {
        throw new Error(`Invalid session ID format: ${sessionId}`);
      }

      if (!this.storage.sessionExists(sessionId)) {
        this.storage.createSession(sessionId);
        isNewSession = true;
      }
    } else {
      sessionId = this.generateSessionId();
      this.storage.createSession(sessionId);
      isNewSession = true;
    }

    logger.info(
      `[MiniMaxAgent] runWithResult: options.sessionId=${options.sessionId}, resolved sessionId=${sessionId}, isNewSession=${isNewSession}`
    );

    const persistedMessages = this.storage.loadMessages(sessionId);
    let baselineMessageCount = 0;
    if (persistedMessages.length > 0) {
      const messages: Message[] = persistedMessages.map((pmsg) => ({
        role: pmsg.role,
        content: pmsg.content,
        thinking: pmsg.thinking,
        toolCalls: pmsg.toolCalls,
        toolCallId: pmsg.toolCallId,
        name: pmsg.name
      }));
      const contextTrimmed = trimMessagesForContextWindow(messages, {
        maxTotalChars: Math.max(24000, Math.min(120000, Math.floor((this.config.tokenLimit ?? 80000) * 2)))
      });
      if (contextTrimmed.removedCount > 0 || contextTrimmed.truncatedCount > 0) {
        logger.warn(
          `[MiniMaxAgent] Context trimmed before run: removed=${contextTrimmed.removedCount}, ` +
            `truncated=${contextTrimmed.truncatedCount}, chars=${contextTrimmed.originalChars}->${contextTrimmed.trimmedChars}`
        );
      }
      this.agent.setMessages(contextTrimmed.messages);
      baselineMessageCount = contextTrimmed.messages.length;
    } else {
      baselineMessageCount = this.agent.getMessages().length;
    }

    if (options.callback) {
      this.agent.setCallback(options.callback);
    }

    if (options.workspaceDir) {
      this.agent.setWorkspaceDir(options.workspaceDir);
    }

    let result: string;
    let usage = undefined;

    if (options.assert) {
      result = await this.agent.runWithAssert(options.prompt, options.assert, 3, sessionId);
    } else {
      const agentResult = await this.agent.runWithResult(options.prompt, sessionId);
      result = agentResult.content;
      usage = agentResult.usage;
    }

    const messages = this.agent.getMessages();
    const newMessages = messages.slice(baselineMessageCount).filter((msg) => msg.role !== "system");

    for (const msg of newMessages) {
      const pmsg = this.storage.messageToPersisted(msg);
      this.storage.appendMessage(sessionId, pmsg);
    }

    const storageConfig = this.storage.getConfig();
    if (this.storage.needsCompression(sessionId)) {
      const allMessages = this.storage.loadMessages(sessionId);
      const compressionResult = await this.compressor.compress(allMessages);

      if (compressionResult.success && compressionResult.compressedContent) {
        this.storage.saveCompressedHistory(
          sessionId,
          compressionResult.compressedContent,
          compressionResult.originalSize
        );
      }
    }

    logger.info(`[MiniMaxAgent] runWithResult returning: sessionId=${sessionId}, isNewSession=${isNewSession}`);

    return {
      content: result,
      sessionId,
      isNewSession,
      usage
    };
  }

  cancel(): void {
    if (this.agent) {
      this.agent.cancel();
    }
  }

  reset(): void {
    if (this.agent) {
      this.agent.reset();
    }
  }

  getConfig(): MiniMaxAgentConfig {
    return this.config;
  }

  getToolRegistry(): ToolRegistry | null {
    return this.toolRegistry;
  }

  getPermissionManager(): PermissionManager | null {
    return this.permissionManager;
  }

  getStorage(): SessionStorage {
    return this.storage;
  }

  getSession(sessionId: string): Session | undefined {
    const meta = this.storage.loadMeta(sessionId);
    if (!meta) return undefined;

    const messages = this.storage.loadMessages(sessionId);
    return {
      id: meta.id,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        thinking: m.thinking,
        toolCalls: m.toolCalls,
        toolCallId: m.toolCallId,
        name: m.name
      })),
      createdAt: new Date(meta.createdAt),
      updatedAt: new Date(meta.updatedAt),
      workspaceDir: meta.workspaceDir,
      additionalDirs: []
    };
  }

  deleteSession(sessionId: string): boolean {
    return this.storage.deleteSession(sessionId);
  }

  listSessions(): string[] {
    return this.storage.listSessions();
  }

  async cleanup(): Promise<void> {
    logger.info(`[MiniMaxAgent] cleanup called`);

    // Cleanup ShellTool processes to prevent memory leaks
    if (this.toolRegistry) {
      const shellTool = this.toolRegistry.get("shell_execute");
      if (shellTool) {
        const shellToolAny = shellTool as any;
        if (typeof shellToolAny.cleanupAll === "function") {
          logger.info(`[MiniMaxAgent] calling shellTool.cleanupAll()`);
          shellToolAny.cleanupAll();
        }
      }
    }

    if (this.mcpConnector) {
      await this.mcpConnector.disconnectAll();
    }
  }
}

export function createMiniMaxAgent(options: MiniMaxAgentOptions): MiniMaxAgent {
  return new MiniMaxAgent(options);
}

export { SessionStorage, ContextCompressor };
export type { MiniMaxRunResult, MiniMaxAgentConfig, MCPServerConfig, AgentCallback };
