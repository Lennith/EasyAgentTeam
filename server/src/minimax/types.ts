import type { TeamToolBridge, TeamToolExecutionContext } from "./tools/team/types.js";

export interface LLMProvider {
  type: "anthropic" | "openai";
}

export interface FunctionCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: FunctionCall;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  thinking?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  source?: {
    type: "base64";
    media_type: string;
    data: string;
  };
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  toolUseId?: string;
  content?: string;
  isError?: boolean;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResponse {
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  finishReason: string;
  usage?: TokenUsage;
}

export interface ToolResult {
  success: boolean;
  content: string;
  error?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentCallback {
  onThinking?: (thinking: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: ToolResult) => void;
  onStep?: (step: number, maxSteps: number) => void;
  onMessage?: (role: string, content: string) => void;
  onError?: (error: Error) => void;
  onProtocolRecovery?: (event: {
    kind: "toolcall_failed_injected" | "toolcall_failed_escalated";
    errorRaw: string;
    missingToolCallId?: string;
    matchedToolName?: string;
    consecutiveFailureCount: number;
    nextAction?: string;
  }) => void;
  onComplete?: (result: string, finishReason?: string) => void;
}

export interface MiniMaxRunOptions {
  prompt: string;
  sessionId?: string;
  content?: string | ContentBlock[];
  assert?: (result: string) => boolean | Promise<boolean>;
  callback?: AgentCallback;
  workspaceDir?: string;
  additionalDirs?: string[];
}

export interface MiniMaxRunResult {
  content: string;
  sessionId: string;
  isNewSession: boolean;
  usage?: TokenUsage;
}

export interface CreateSessionOptions {
  workspaceDir?: string;
  additionalDirs?: string[];
  systemPrompt?: string;
}

export interface Session {
  id: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  workspaceDir: string;
  additionalDirs: string[];
  systemPrompt?: string;
}

export interface MCPServerConfig {
  name: string;
  type: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  connectTimeout?: number;
  executeTimeout?: number;
}

export interface SkillConfig {
  name: string;
  description: string;
  path: string;
  enabled?: boolean;
}

export interface MiniMaxAgentConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  maxSteps: number;
  tokenLimit: number;
  workspaceDir: string;
  sessionDir?: string;
  systemPromptPath?: string;
  skillListPath?: string;
  enableFileTools: boolean;
  enableShell: boolean;
  enableNote: boolean;
  shellType: "powershell" | "cmd";
  shellTimeout: number;
  shellOutputIdleTimeout?: number;
  shellMaxRunTime?: number;
  shellMaxOutputSize?: number;
  shellLogDir?: string;
  mcpEnabled: boolean;
  mcpServers: MCPServerConfig[];
  mcpConnectTimeout: number;
  mcpExecuteTimeout: number;
  env?: Record<string, string>;
  additionalWritableDirs?: string[];
  teamToolContext?: TeamToolExecutionContext;
  teamToolBridge?: TeamToolBridge;
}

export type ShellType = "powershell" | "cmd";

export interface ShellExecuteOptions {
  command: string;
  shell?: ShellType;
  timeout?: number;
  cwd?: string;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface DirectoryPermissions {
  workspaceDir: string;
  additionalWritableDirs: string[];
}

export interface PersistedMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  metadata?: {
    tokenCount?: number;
    compressed?: boolean;
    originalSize?: number;
    compressedSize?: number;
  };
}

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  workspaceDir: string;
  currentIndex: number;
  totalSize: number;
  compressedCount: number;
}

export interface SessionStorageConfig {
  persistDir?: string;
  maxContentSize?: number;
  compressionThreshold?: number;
  targetCompressionRatio?: number;
  autoCompress?: boolean;
}

export const DEFAULT_STORAGE_CONFIG: Required<SessionStorageConfig> = {
  persistDir: "minimax-session",
  maxContentSize: 200 * 1024,
  compressionThreshold: 200 * 1024,
  targetCompressionRatio: 0.3,
  autoCompress: true
};
