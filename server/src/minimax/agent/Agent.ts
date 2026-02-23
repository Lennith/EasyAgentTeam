import * as path from 'path';
import * as fs from 'fs';
import {
  LLMClient,
  extractMissingToolCallId,
  isMiniMaxToolResultIdNotFoundError
} from '../llm/LLMClient.js';
import { ToolRegistry, Tool } from '../tools/index.js';
import { logger } from '../../utils/logger.js';
import type {
  Message,
  AgentCallback,
  ToolResult,
  ToolCall,
  Session,
  TokenUsage,
  LLMResponse,
} from '../types.js';

export interface AgentRunResult {
  content: string;
  usage?: TokenUsage;
}

export interface AgentOptions {
  llmClient: LLMClient;
  toolRegistry: ToolRegistry;
  systemPrompt: string;
  maxSteps?: number;
  tokenLimit?: number;
  workspaceDir?: string;
  callback?: AgentCallback;
  mcpToolDescriptions?: string;
}

export class Agent {
  private llm: LLMClient;
  private tools: ToolRegistry;
  private systemPrompt: string;
  private maxSteps: number;
  private tokenLimit: number;
  private workspaceDir: string;
  private callback?: AgentCallback;
  private mcpToolDescriptions?: string;
  
  private messages: Message[] = [];
  private sessionId: string | null = null;
  private isRunning: boolean = false;
  private abortController: AbortController | null = null;
  private lastUsage: TokenUsage | undefined;

  constructor(options: AgentOptions) {
    this.llm = options.llmClient;
    this.tools = options.toolRegistry;
    this.systemPrompt = options.systemPrompt;
    this.maxSteps = options.maxSteps ?? 100;
    this.tokenLimit = options.tokenLimit ?? 80000;
    this.workspaceDir = path.resolve(options.workspaceDir ?? './workspace');
    this.callback = options.callback;
    this.mcpToolDescriptions = options.mcpToolDescriptions;

    this.ensureWorkspace();
    this.initializeMessages();
  }

  private ensureWorkspace(): void {
    if (!fs.existsSync(this.workspaceDir)) {
      fs.mkdirSync(this.workspaceDir, { recursive: true });
    }
  }

  private initializeMessages(): void {
    let prompt = this.systemPrompt;
    
    if (!prompt.includes('Current Workspace')) {
      prompt += `\n\n## Current Workspace\nYou are currently working in: \`${this.workspaceDir}\`\nAll relative paths will be resolved relative to this directory.`;
    }
    
    if (this.mcpToolDescriptions) {
      prompt += `\n\n## MCP Tools\nYou have access to the following MCP (Model Context Protocol) tools:\n${this.mcpToolDescriptions}`;
    }
    
    this.messages = [{ role: 'system', content: prompt }];
  }

  private ensureSystemPrompt(): void {
    if (this.messages.length === 0 || this.messages[0].role !== 'system') {
      let prompt = this.systemPrompt;
      
      if (!prompt.includes('Current Workspace')) {
        prompt += `\n\n## Current Workspace\nYou are currently working in: \`${this.workspaceDir}\`\nAll relative paths will be resolved relative to this directory.`;
      }
      
      if (this.mcpToolDescriptions) {
        prompt += `\n\n## MCP Tools\nYou have access to the following MCP (Model Context Protocol) tools:\n${this.mcpToolDescriptions}`;
      }
      
      this.messages.unshift({ role: 'system', content: prompt });
    }
  }

  setCallback(callback: AgentCallback): void {
    this.callback = callback;
  }

  addTool(tool: Tool): void {
    this.tools.register(tool);
  }

  removeTool(name: string): void {
    this.tools.unregister(name);
  }

  addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content });
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  setMessages(messages: Message[]): void {
    const hasSystemPrompt = this.messages.length > 0 && this.messages[0].role === 'system';
    const incomingHasSystem = messages.length > 0 && messages[0].role === 'system';
    
    if (hasSystemPrompt && !incomingHasSystem) {
      this.messages = [this.messages[0], ...messages];
    } else {
      this.messages = [...messages];
    }
  }

  getLastUsage(): TokenUsage | undefined {
    return this.lastUsage;
  }

  getSession(): Session {
    return {
      id: this.sessionId ?? '',
      messages: this.messages,
      createdAt: new Date(),
      updatedAt: new Date(),
      workspaceDir: this.workspaceDir,
      additionalDirs: [],
    };
  }

  setSession(session: Session): void {
    this.sessionId = session.id;
    this.messages = [...session.messages];
  }

  private findToolNameById(toolCallId: string | undefined): string | undefined {
    if (!toolCallId || toolCallId.trim().length === 0) {
      return undefined;
    }
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const message = this.messages[i];
      if (message.role !== "assistant" || !message.toolCalls) {
        continue;
      }
      const matched = message.toolCalls.find((item) => item.id === toolCallId);
      if (matched) {
        return matched.function.name;
      }
    }
    return undefined;
  }

  private buildToolCallFailedMessage(input: {
    errorRaw: string;
    missingToolCallId?: string;
    matchedToolName?: string;
    consecutiveFailureCount: number;
  }): string {
    const missingToolCallId = input.missingToolCallId ?? "(unknown)";
    const matchedToolName = input.matchedToolName ?? "(unknown)";
    return [
      "[TOOLCALL_FAILED]",
      `error_raw=${input.errorRaw}`,
      `missing_tool_call_id=${missingToolCallId}`,
      `matched_tool_name=${matchedToolName}`,
      `consecutive_failure_count=${input.consecutiveFailureCount}`,
      "next_action=Do not reuse stale tool_result. Issue a fresh tool call and continue from current task state."
    ].join("\n");
  }

  async run(prompt: string, sessionId?: string): Promise<string> {
    const result = await this.runWithResult(prompt, sessionId);
    return result.content;
  }

    async runWithResult(prompt: string, sessionId?: string): Promise<AgentRunResult> {
    if (this.isRunning) {
      throw new Error('Agent is already running');
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    
    if (sessionId) {
      this.sessionId = sessionId;
    }

    this.addUserMessage(prompt);
    
    let step = 0;
    let lastResult = '';
    let lastUsage: TokenUsage | undefined;
    let consecutiveToolCallProtocolFailures = 0;

    try {
      while (step < this.maxSteps) {
        if (this.abortController.signal.aborted) {
          return { content: 'Task cancelled by user.', usage: lastUsage };
        }

        this.callback?.onStep?.(step + 1, this.maxSteps);

        let response: LLMResponse;
        try {
          response = await this.llm.generate(
            this.messages,
            this.tools.getSchemas()
          );
          consecutiveToolCallProtocolFailures = 0;
        } catch (error) {
          if (!isMiniMaxToolResultIdNotFoundError(error)) {
            throw error;
          }
          const errorRaw = error instanceof Error ? error.message : String(error);
          const missingToolCallId = extractMissingToolCallId(errorRaw);
          const matchedToolName = this.findToolNameById(missingToolCallId);
          const nextCount = consecutiveToolCallProtocolFailures + 1;
          const recoveryMessage = this.buildToolCallFailedMessage({
            errorRaw,
            missingToolCallId,
            matchedToolName,
            consecutiveFailureCount: nextCount
          });
          this.messages.push({
            role: "user",
            content: recoveryMessage
          });
          this.callback?.onMessage?.("system", recoveryMessage);
          this.callback?.onProtocolRecovery?.({
            kind: nextCount >= 2 ? "toolcall_failed_escalated" : "toolcall_failed_injected",
            errorRaw,
            missingToolCallId,
            matchedToolName,
            consecutiveFailureCount: nextCount,
            nextAction: "Issue a fresh tool call, then continue reporting progress."
          });
          consecutiveToolCallProtocolFailures = nextCount;
          if (nextCount >= 2) {
            throw new Error(`[TOOLCALL_FAILED_ESCALATED] ${errorRaw}`);
          }
          step++;
          continue;
        }

        if (response.usage) {
          lastUsage = response.usage;
          this.lastUsage = response.usage;
        }

        const assistantMsg: Message = {
          role: 'assistant',
          content: response.content,
          thinking: response.thinking,
          toolCalls: response.toolCalls,
        };
        this.messages.push(assistantMsg);

        if (response.thinking) {
          this.callback?.onThinking?.(response.thinking);
        }

        if (response.content) {
          this.callback?.onMessage?.('assistant', response.content);
        }

        if (response.toolCalls && response.toolCalls.length > 0) {
          lastResult = response.content;
          for (const toolCall of response.toolCalls) {
            if (this.abortController.signal.aborted) {
              return { content: 'Task cancelled by user.', usage: lastUsage };
            }
            const { name, arguments: args } = toolCall.function; 
            this.callback?.onToolCall?.(name, args);
            const result = await this.tools.execute(name, args);
            this.callback?.onToolResult?.(name, result);
            const toolMsg: Message = {
                role: 'tool',
                content: result.success ? result.content : `Error: ${result.error}`,
                toolCallId: toolCall.id,
                name,
              };
              this.messages.push(toolMsg);
          }
        }
        step++;
        if(response.finishReason != "tool_use"){
          // Pass finishReason separately to callback
          this.callback?.onComplete?.(lastResult, response.finishReason);
          return { content: response.finishReason + lastResult, usage: lastUsage };
        }

        // Log full response to minimax.log for debugging
        logger.minimax(`[Response] step=${step}, finishReason=${response.finishReason}, content length=${response.content.length}, thinking=${response.thinking ? 'yes' : 'no'}, toolCalls=${response.toolCalls?.length ?? 0}`);
        
        // Log unhandled content blocks
        if (response.toolCalls && response.toolCalls.length > 0) {
          logger.minimax(`[ToolCalls] ${JSON.stringify(response.toolCalls.map(tc => ({ id: tc.id, name: tc.function.name })))}`);
        }
      }

      if (step >= this.maxSteps) {
        lastResult = `Task couldn't be completed after ${this.maxSteps} steps.`;
      }

      this.callback?.onComplete?.(lastResult);
      return { content: lastResult, usage: lastUsage };

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.callback?.onError?.(err);
      throw err;
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }
  }

  async runWithAssert(
    prompt: string,
    assertFn: (result: string) => boolean | Promise<boolean>,
    maxRetries: number = 3,
    sessionId?: string
  ): Promise<string> {
    let lastResult = '';
    let retries = 0;

    while (retries < maxRetries) {
      lastResult = await this.run(prompt, sessionId);
      
      const passed = await assertFn(lastResult);
      if (passed) {
        return lastResult;
      }

      retries++;
      
      if (retries < maxRetries) {
        this.addUserMessage(
          `The previous result did not meet the requirements. Please try again. Attempt ${retries + 1}/${maxRetries}.`
        );
      }
    }

    return lastResult;
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  reset(): void {
    this.messages = [];
    this.sessionId = null;
    this.initializeMessages();
  }

  setWorkspaceDir(dir: string): void {
    this.workspaceDir = path.resolve(dir);
    this.ensureWorkspace();
    this.initializeMessages();
  }
}
