import * as path from "path";
import * as fs from "fs";
import {
  LLMClient,
  extractMissingToolCallId,
  isMiniMaxToolResultIdNotFoundError,
  trimMessagesForContextWindow
} from "../llm/LLMClient.js";
import { ToolRegistry, Tool } from "../tools/index.js";
import { logger } from "../../utils/logger.js";
import { ContextCompressor } from "../compression/ContextCompressor.js";
import type {
  Message,
  AgentCallback,
  ToolResult,
  ToolCall,
  Session,
  TokenUsage,
  LLMResponse,
  MaxTokensRecoveryEvent,
  PersistedMessage
} from "../types.js";

export interface AgentRunResult {
  content: string;
  finishReason?: string;
  step: number;
  usage?: TokenUsage;
  recoveredFromMaxTokens?: boolean;
  maxTokensRecoveryAttempt?: number;
  maxTokensEvents?: MaxTokensRecoveryEvent[];
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
  maxTokensRecoveryMaxAttempts?: number;
}

export class Agent {
  private static readonly DEFAULT_TOOL_RESULT_CHAR_LIMIT = 4000;
  private llm: LLMClient;
  private tools: ToolRegistry;
  private systemPrompt: string;
  private maxSteps: number;
  private tokenLimit: number;
  private workspaceDir: string;
  private callback?: AgentCallback;
  private mcpToolDescriptions?: string;
  private contextCompressor: ContextCompressor;
  private maxTokensRecoveryMaxAttempts: number;

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
    this.workspaceDir = path.resolve(options.workspaceDir ?? "./workspace");
    this.callback = options.callback;
    this.mcpToolDescriptions = options.mcpToolDescriptions;
    this.contextCompressor = new ContextCompressor(this.llm, 0.35);
    this.maxTokensRecoveryMaxAttempts = Math.max(0, Math.floor(options.maxTokensRecoveryMaxAttempts ?? 2));

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

    if (!prompt.includes("Current Workspace")) {
      prompt += `\n\n## Current Workspace\nYou are currently working in: \`${this.workspaceDir}\`\nAll relative paths will be resolved relative to this directory.`;
    }

    if (this.mcpToolDescriptions) {
      prompt += `\n\n## MCP Tools\nYou have access to the following MCP (Model Context Protocol) tools:\n${this.mcpToolDescriptions}`;
    }

    this.messages = [{ role: "system", content: prompt }];
  }

  private ensureSystemPrompt(): void {
    if (this.messages.length === 0 || this.messages[0].role !== "system") {
      let prompt = this.systemPrompt;

      if (!prompt.includes("Current Workspace")) {
        prompt += `\n\n## Current Workspace\nYou are currently working in: \`${this.workspaceDir}\`\nAll relative paths will be resolved relative to this directory.`;
      }

      if (this.mcpToolDescriptions) {
        prompt += `\n\n## MCP Tools\nYou have access to the following MCP (Model Context Protocol) tools:\n${this.mcpToolDescriptions}`;
      }

      this.messages.unshift({ role: "system", content: prompt });
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
    this.messages.push({ role: "user", content });
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  setMessages(messages: Message[]): void {
    const hasSystemPrompt = this.messages.length > 0 && this.messages[0].role === "system";
    const incomingHasSystem = messages.length > 0 && messages[0].role === "system";

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
      id: this.sessionId ?? "",
      messages: this.messages,
      createdAt: new Date(),
      updatedAt: new Date(),
      workspaceDir: this.workspaceDir,
      additionalDirs: []
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

  private messageTextContent(content: Message["content"]): string {
    if (typeof content === "string") {
      return content;
    }
    return content
      .map((block) => {
        if (block.type === "text") {
          return block.text ?? "";
        }
        if (block.type === "tool_result") {
          return block.content ?? "";
        }
        if (block.type === "tool_use") {
          return JSON.stringify(block.input ?? {});
        }
        return "";
      })
      .join("\n");
  }

  private estimateMessageChars(message: Message): number {
    const base = this.messageTextContent(message.content).length;
    const thinking = message.thinking?.length ?? 0;
    const toolCalls = message.toolCalls ? JSON.stringify(message.toolCalls).length : 0;
    return base + thinking + toolCalls;
  }

  private estimateTotalChars(messages: Message[]): number {
    return messages.reduce((sum, message) => sum + this.estimateMessageChars(message), 0);
  }

  private truncate(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
      return value;
    }
    return `${value.slice(0, Math.max(0, maxChars - 18))}...(truncated)`;
  }

  private resolveToolResultCharLimit(toolName?: string): number {
    const normalized = (toolName ?? "").trim().toLowerCase();
    if (normalized === "read_file") {
      return 6000;
    }
    if (normalized.startsWith("task_report_")) {
      return 3500;
    }
    if (normalized === "lock_manage") {
      return 1500;
    }
    if (
      normalized === "task_create_assign" ||
      normalized === "route_targets_get" ||
      normalized.startsWith("discuss_") ||
      normalized.startsWith("task_discuss_")
    ) {
      return 3000;
    }
    return Agent.DEFAULT_TOOL_RESULT_CHAR_LIMIT;
  }

  private sanitizeToolMessageBeforeAppend(message: Message): Message {
    if (message.role !== "tool") {
      return message;
    }
    const maxChars = this.resolveToolResultCharLimit(message.name);
    const original = this.messageTextContent(message.content);
    if (original.length <= maxChars) {
      return message;
    }
    const normalizedToolName = (message.name ?? "(unknown)").trim() || "(unknown)";
    const header = `[TOOL_RESULT_TRUNCATED tool=${normalizedToolName} original_chars=${original.length} kept_chars=${maxChars}]`;
    const bodyBudget = maxChars - header.length - 1;
    const body = bodyBudget > 0 ? original.slice(0, bodyBudget) : "";
    const finalContent = body.length > 0 ? `${header}\n${body}` : header.slice(0, maxChars);
    return {
      ...message,
      content: finalContent
    };
  }

  private compactCompletedToolHistory(messages: Message[]): {
    messages: Message[];
    compactedToolCallChains: number;
    compactedToolMessages: number;
  } {
    if (messages.length <= 3) {
      return { messages: [...messages], compactedToolCallChains: 0, compactedToolMessages: 0 };
    }

    const hasSystem = messages[0]?.role === "system";
    const systemMessage = hasSystem ? messages[0] : null;
    const body = hasSystem ? messages.slice(1) : [...messages];
    const tailWindow = Math.min(20, body.length);
    const splitIndex = Math.max(0, body.length - tailWindow);
    const head = body.slice(0, splitIndex);
    const tail = body.slice(splitIndex);

    const compactedHead: Message[] = [];
    const summaries: string[] = [];
    let compactedToolCallChains = 0;
    let compactedToolMessages = 0;

    for (let i = 0; i < head.length; i += 1) {
      const message = head[i];
      if (message.role !== "assistant" || !message.toolCalls || message.toolCalls.length === 0) {
        compactedHead.push(message);
        continue;
      }

      const expectedToolCalls = message.toolCalls;
      const expectedIds = new Set(
        expectedToolCalls.map((toolCall) => toolCall.id?.trim()).filter((id): id is string => Boolean(id))
      );
      if (expectedIds.size !== expectedToolCalls.length) {
        compactedHead.push(message);
        continue;
      }

      const alignedResults: Message[] = [];
      let cursor = i + 1;
      while (cursor < head.length && head[cursor].role === "tool") {
        alignedResults.push(head[cursor]);
        cursor += 1;
      }
      if (alignedResults.length < expectedToolCalls.length) {
        compactedHead.push(message);
        continue;
      }

      const matchIds = new Set<string>();
      let aligned = true;
      for (const toolMessage of alignedResults.slice(0, expectedToolCalls.length)) {
        const toolCallId = toolMessage.toolCallId?.trim();
        if (!toolCallId || !expectedIds.has(toolCallId) || matchIds.has(toolCallId)) {
          aligned = false;
          break;
        }
        matchIds.add(toolCallId);
      }
      if (!aligned || matchIds.size !== expectedIds.size) {
        compactedHead.push(message);
        continue;
      }

      const chainResults = alignedResults.slice(0, expectedToolCalls.length);
      const resultSummary = chainResults
        .map((toolMessage) => this.truncate(this.messageTextContent(toolMessage.content).replace(/\s+/g, " "), 100))
        .join(" | ");
      const toolNames = expectedToolCalls.map((toolCall) => toolCall.function.name).join(", ");
      summaries.push(
        `tools=[${toolNames}] results=${this.truncate(resultSummary.length > 0 ? resultSummary : "(empty)", 220)}`
      );

      compactedToolCallChains += 1;
      compactedToolMessages += chainResults.length + 1;
      i = cursor - 1;
    }

    if (compactedToolCallChains === 0) {
      return { messages: [...messages], compactedToolCallChains: 0, compactedToolMessages: 0 };
    }

    const summaryPreview = summaries.slice(0, 12).join("\n- ");
    const overflowCount = Math.max(0, summaries.length - 12);
    const summaryMessage: Message = {
      role: "user",
      content:
        `[TOOL_HISTORY_COMPACTED] compacted_chains=${compactedToolCallChains}, compacted_messages=${compactedToolMessages}\n` +
        `- ${summaryPreview}\n` +
        (overflowCount > 0 ? `- ...and ${overflowCount} more compacted chain(s).` : "") +
        "\nKeep only latest tool protocol details in subsequent reasoning."
    };

    const nextMessages: Message[] = [];
    if (systemMessage) {
      nextMessages.push(systemMessage);
    }
    nextMessages.push(...compactedHead, summaryMessage, ...tail);
    return { messages: nextMessages, compactedToolCallChains, compactedToolMessages };
  }

  private toPersistedMessages(messages: Message[]): PersistedMessage[] {
    const now = new Date().toISOString();
    return messages.map((message, index) => ({
      id: `msg-${index + 1}`,
      role: message.role,
      content: this.messageTextContent(message.content),
      timestamp: now,
      thinking: message.thinking,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
      name: message.name
    }));
  }

  private async compressForMaxTokensRecovery(messages: Message[]): Promise<{
    messages: Message[];
    compressionMode: "llm_compressor" | "deterministic_trim" | "none";
    compressionError?: string;
  }> {
    if (messages.length <= 2) {
      return { messages: [...messages], compressionMode: "none" };
    }

    const hasSystem = messages[0]?.role === "system";
    const systemMessage = hasSystem ? messages[0] : null;
    const body = hasSystem ? messages.slice(1) : [...messages];
    const keepTail = Math.min(16, body.length);
    const olderMessages = body.slice(0, Math.max(0, body.length - keepTail));
    const tailMessages = body.slice(Math.max(0, body.length - keepTail));

    if (olderMessages.length > 2) {
      try {
        const compressed = await this.contextCompressor.compress(this.toPersistedMessages(olderMessages));
        if (compressed.success && compressed.compressedContent) {
          const summaryMessage: Message = {
            role: "user",
            content:
              "[CONTEXT_COMPRESSED] Earlier history summary:\n" +
              this.truncate(compressed.compressedContent, 10000) +
              "\nUse this summary as canonical history for older steps."
          };
          const nextMessages: Message[] = [];
          if (systemMessage) {
            nextMessages.push(systemMessage);
          }
          nextMessages.push(summaryMessage, ...tailMessages);
          return { messages: nextMessages, compressionMode: "llm_compressor" };
        }
        return {
          messages: this.applyDeterministicTrim(messages),
          compressionMode: "deterministic_trim",
          compressionError: compressed.error ?? "llm_compressor_returned_empty"
        };
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        return {
          messages: this.applyDeterministicTrim(messages),
          compressionMode: "deterministic_trim",
          compressionError: err
        };
      }
    }

    return {
      messages: this.applyDeterministicTrim(messages),
      compressionMode: "deterministic_trim"
    };
  }

  private applyDeterministicTrim(messages: Message[]): Message[] {
    const trimBudget = Math.max(24000, Math.min(120000, Math.floor(this.tokenLimit * 2)));
    const trimmed = trimMessagesForContextWindow(messages, {
      maxTotalChars: trimBudget,
      keepLatestCount: 16,
      maxToolChars: 2000,
      maxNonToolChars: 6000
    });
    return trimmed.messages;
  }

  private buildMaxTokensContinuationPrompt(attempt: number, maxAttempts: number): string {
    return [
      "[MAX_TOKENS_RECOVERY]",
      `continuation_attempt=${attempt}/${maxAttempts}`,
      "Continue from the latest valid state with concise progress only.",
      "Do not repeat prior analysis; prioritize next actionable step."
    ].join("\n");
  }

  async run(prompt: string, sessionId?: string): Promise<string> {
    const result = await this.runWithResult(prompt, sessionId);
    return result.content;
  }

  async runWithResult(prompt: string, sessionId?: string): Promise<AgentRunResult> {
    if (this.isRunning) {
      throw new Error("Agent is already running");
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    if (sessionId) {
      this.sessionId = sessionId;
    }

    this.addUserMessage(prompt);

    let step = 0;
    let lastResult = "";
    let lastUsage: TokenUsage | undefined;
    let consecutiveToolCallProtocolFailures = 0;
    let maxTokensRecoveryAttempt = 0;
    let recoveredFromMaxTokens = false;
    const maxTokensEvents: MaxTokensRecoveryEvent[] = [];

    try {
      while (step < this.maxSteps) {
        if (this.abortController.signal.aborted) {
          return { content: "Task cancelled by user.", finishReason: "cancelled", step, usage: lastUsage };
        }

        this.callback?.onStep?.(step + 1, this.maxSteps);

        let response: LLMResponse;
        try {
          response = await this.llm.generate(this.messages, this.tools.getSchemas());
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
          role: "assistant",
          content: response.content,
          thinking: response.thinking,
          toolCalls: response.toolCalls
        };
        this.messages.push(assistantMsg);

        if (response.thinking) {
          this.callback?.onThinking?.(response.thinking);
        }

        if (response.content) {
          lastResult = response.content;
          this.callback?.onMessage?.("assistant", response.content);
        }

        if (response.toolCalls && response.toolCalls.length > 0) {
          for (const toolCall of response.toolCalls) {
            if (this.abortController.signal.aborted) {
              return { content: "Task cancelled by user.", finishReason: "cancelled", step, usage: lastUsage };
            }
            const { name, arguments: args } = toolCall.function;
            this.callback?.onToolCall?.(name, args);
            const result = await this.tools.execute(name, args);
            this.callback?.onToolResult?.(name, result);
            const toolMsg: Message = {
              role: "tool",
              content: result.success ? result.content : `Error: ${result.error}`,
              toolCallId: toolCall.id,
              name
            };
            this.messages.push(this.sanitizeToolMessageBeforeAppend(toolMsg));
          }
        }
        const currentStep = step + 1;

        if (response.finishReason === "max_tokens") {
          const preCompressMessageCount = this.messages.length;
          const preCompressChars = this.estimateTotalChars(this.messages);
          const compacted = this.compactCompletedToolHistory(this.messages);
          this.messages = compacted.messages;
          const compressed = await this.compressForMaxTokensRecovery(this.messages);
          this.messages = compressed.messages;

          const attempt = maxTokensRecoveryAttempt + 1;
          const recovered = attempt <= this.maxTokensRecoveryMaxAttempts;
          if (recovered) {
            recoveredFromMaxTokens = true;
            this.messages.push({
              role: "user",
              content: this.buildMaxTokensContinuationPrompt(attempt, this.maxTokensRecoveryMaxAttempts)
            });
          }

          const event: MaxTokensRecoveryEvent = {
            observedAt: new Date().toISOString(),
            step: currentStep,
            attempt,
            maxAttempts: this.maxTokensRecoveryMaxAttempts,
            recovered,
            finishReason: "max_tokens",
            usage: lastUsage,
            preCompressMessageCount,
            preCompressChars,
            postCompressMessageCount: this.messages.length,
            postCompressChars: this.estimateTotalChars(this.messages),
            compactedToolCallChains: compacted.compactedToolCallChains,
            compactedToolMessages: compacted.compactedToolMessages,
            compressionMode: compressed.compressionMode,
            compressionError: compressed.compressionError,
            continuationInjected: recovered
          };
          maxTokensEvents.push(event);
          await Promise.resolve(this.callback?.onMaxTokensRecovery?.(event));
          maxTokensRecoveryAttempt = attempt;
          if (recovered) {
            step = currentStep;
            continue;
          }

          this.callback?.onComplete?.(lastResult, response.finishReason, {
            finishReason: response.finishReason,
            usage: lastUsage,
            step: currentStep,
            recoveredFromMaxTokens,
            maxTokensRecoveryAttempt,
            maxTokensEvents,
            maxTokensSnapshotPath: event.maxTokensSnapshotPath ?? null
          });
          return {
            content: lastResult,
            finishReason: response.finishReason,
            step: currentStep,
            usage: lastUsage,
            recoveredFromMaxTokens,
            maxTokensRecoveryAttempt,
            maxTokensEvents
          };
        }

        if (response.finishReason != "tool_use") {
          this.callback?.onComplete?.(lastResult, response.finishReason, {
            finishReason: response.finishReason,
            usage: lastUsage,
            step: currentStep,
            recoveredFromMaxTokens,
            maxTokensRecoveryAttempt,
            maxTokensEvents
          });
          return {
            content: lastResult,
            finishReason: response.finishReason,
            step: currentStep,
            usage: lastUsage,
            recoveredFromMaxTokens,
            maxTokensRecoveryAttempt,
            maxTokensEvents
          };
        }

        step = currentStep;

        // Log full response to minimax.log for debugging
        logger.minimax(
          `[Response] step=${step}, finishReason=${response.finishReason}, content length=${response.content.length}, thinking=${response.thinking ? "yes" : "no"}, toolCalls=${response.toolCalls?.length ?? 0}`
        );

        // Log unhandled content blocks
        if (response.toolCalls && response.toolCalls.length > 0) {
          logger.minimax(
            `[ToolCalls] ${JSON.stringify(response.toolCalls.map((tc) => ({ id: tc.id, name: tc.function.name })))}`
          );
        }
      }

      if (step >= this.maxSteps) {
        lastResult = `Task couldn't be completed after ${this.maxSteps} steps.`;
      }

      this.callback?.onComplete?.(lastResult, "max_steps", {
        finishReason: "max_steps",
        usage: lastUsage,
        step,
        recoveredFromMaxTokens,
        maxTokensRecoveryAttempt,
        maxTokensEvents
      });
      return {
        content: lastResult,
        finishReason: "max_steps",
        step,
        usage: lastUsage,
        recoveredFromMaxTokens,
        maxTokensRecoveryAttempt,
        maxTokensEvents
      };
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
    let lastResult = "";
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
