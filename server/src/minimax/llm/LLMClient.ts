import Anthropic from '@anthropic-ai/sdk';
import type { Message, LLMResponse, ToolSchema, ToolCall, TokenUsage } from '../types.js';

const MINIMAX_DOMAINS = ['api.minimax.io', 'api.minimaxi.com'];

export interface StreamCallbacks {
  onText?: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolUse?: (id: string, name: string, input: Record<string, unknown>) => void;
  onComplete?: (response: LLMResponse) => void;
}

export interface LLMClientConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  maxTokens?: number;
}

export interface ToolProtocolSanitizeResult {
  messages: Message[];
  correctedCount: number;
}

export interface ContextWindowTrimOptions {
  maxTotalChars?: number;
  keepLatestCount?: number;
  maxToolChars?: number;
  maxNonToolChars?: number;
}

export interface ContextWindowTrimResult {
  messages: Message[];
  originalChars: number;
  trimmedChars: number;
  removedCount: number;
  truncatedCount: number;
}

const DEFAULT_CONTEXT_MAX_CHARS = 120000;
const DEFAULT_KEEP_LATEST_COUNT = 24;
const DEFAULT_TOOL_MAX_CHARS = 4000;
const DEFAULT_NON_TOOL_MAX_CHARS = 12000;

export function sanitizeMessagesForToolProtocol(messages: Message[]): ToolProtocolSanitizeResult {
  const sanitized: Message[] = [];
  const pendingToolUseIds = new Set<string>();
  let correctedCount = 0;

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const toolCall of message.toolCalls ?? []) {
        if (toolCall.id && toolCall.id.trim().length > 0) {
          pendingToolUseIds.add(toolCall.id);
        }
      }
      sanitized.push(message);
      continue;
    }

    if (message.role === 'tool') {
      const toolCallId = message.toolCallId?.trim();
      if (toolCallId && pendingToolUseIds.has(toolCallId)) {
        pendingToolUseIds.delete(toolCallId);
        sanitized.push(message);
        continue;
      }

      correctedCount += 1;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      const truncated = content.length > 500 ? `${content.slice(0, 500)}...(truncated)` : content;
      sanitized.push({
        role: 'user',
        content:
          `[TOOLCALL_FAILED] Invalid tool_result without matching tool_use.` +
          ` tool_call_id=${toolCallId ?? '(missing)'}, tool=${message.name ?? '(unknown)'}.` +
          ` original_content=${truncated}.` +
          ` next_action=Issue a fresh tool call and continue.`
      });
      continue;
    }

    sanitized.push(message);
  }

  return { messages: sanitized, correctedCount };
}

export function isMiniMaxToolResultIdNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("(2013)") &&
    normalized.includes("tool id") &&
    normalized.includes("not found")
  );
}

export function extractMissingToolCallId(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const patterns = [
    /tool id\(([^)]+)\)\s+not found/i,
    /tool[_\s-]*use[_\s-]*id[=:]\s*([a-z0-9._:-]+)/i
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match && match[1]) {
      const id = match[1].trim();
      if (id.length > 0) {
        return id;
      }
    }
  }
  return undefined;
}

export function isMiniMaxContextWindowExceededError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("context window exceeds limit") ||
    (normalized.includes("(2013)") && normalized.includes("context window"))
  );
}

function messageTextContent(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  const parts = content.map((block) => {
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
  });
  return parts.join("\n");
}

function estimateMessageCharacters(message: Message): number {
  const base = messageTextContent(message.content).length;
  const thinking = message.thinking?.length ?? 0;
  const toolCalls = message.toolCalls ? JSON.stringify(message.toolCalls).length : 0;
  return base + thinking + toolCalls;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const kept = Math.max(0, maxChars - 64);
  const removed = value.length - kept;
  return `${value.slice(0, kept)}\n...[CONTEXT_TRUNCATED removed_chars=${removed}]`;
}

function normalizeMessageContent(message: Message, maxChars: number): Message {
  const raw = messageTextContent(message.content);
  const trimmed = truncateText(raw, maxChars);
  if (trimmed === raw && typeof message.content === "string") {
    return message;
  }
  return {
    ...message,
    content: trimmed
  };
}

export function trimMessagesForContextWindow(
  messages: Message[],
  options: ContextWindowTrimOptions = {}
): ContextWindowTrimResult {
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_CONTEXT_MAX_CHARS;
  const keepLatestCount = options.keepLatestCount ?? DEFAULT_KEEP_LATEST_COUNT;
  const maxToolChars = options.maxToolChars ?? DEFAULT_TOOL_MAX_CHARS;
  const maxNonToolChars = options.maxNonToolChars ?? DEFAULT_NON_TOOL_MAX_CHARS;

  const originalChars = messages.reduce((sum, message) => sum + estimateMessageCharacters(message), 0);
  if (messages.length === 0 || originalChars <= maxTotalChars) {
    return {
      messages: [...messages],
      originalChars,
      trimmedChars: originalChars,
      removedCount: 0,
      truncatedCount: 0
    };
  }

  const hasSystem = messages[0]?.role === "system";
  const systemMessage = hasSystem ? messages[0] : null;
  const contentMessages = hasSystem ? messages.slice(1) : [...messages];

  let truncatedCount = 0;
  const normalizedContentMessages = contentMessages.map((message) => {
    const cap = message.role === "tool" ? maxToolChars : maxNonToolChars;
    const next = normalizeMessageContent(message, cap);
    if (estimateMessageCharacters(next) < estimateMessageCharacters(message)) {
      truncatedCount += 1;
    }
    return next;
  });

  const reserveForNotice = 220;
  const contentBudget = Math.max(1000, maxTotalChars - (systemMessage ? estimateMessageCharacters(systemMessage) : 0) - reserveForNotice);

  const selected: Message[] = [];
  let selectedChars = 0;
  for (let i = normalizedContentMessages.length - 1; i >= 0; i -= 1) {
    const candidate = normalizedContentMessages[i];
    const candidateChars = estimateMessageCharacters(candidate);
    if (selected.length < keepLatestCount || selectedChars + candidateChars <= contentBudget) {
      selected.push(candidate);
      selectedChars += candidateChars;
      continue;
    }
    break;
  }

  selected.reverse();
  const removedCount = Math.max(0, normalizedContentMessages.length - selected.length);
  const notice: Message | null =
    removedCount > 0
      ? {
          role: "user",
          content:
            `[CONTEXT_WINDOW_GUARD] Earlier context was trimmed to fit model limit.` +
            ` removed_messages=${removedCount}, retained_messages=${selected.length}.`
        }
      : null;

  const resultMessages: Message[] = [];
  if (systemMessage) {
    resultMessages.push(systemMessage);
  }
  if (notice) {
    resultMessages.push(notice);
  }
  resultMessages.push(...selected);

  const trimmedChars = resultMessages.reduce((sum, message) => sum + estimateMessageCharacters(message), 0);
  return {
    messages: resultMessages,
    originalChars,
    trimmedChars,
    removedCount,
    truncatedCount
  };
}

export class LLMClient {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;

  constructor(config: LLMClientConfig) {
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 4096;

    let apiBase = config.apiBase.replace(/\/$/, '');
    
    const isMinimax = MINIMAX_DOMAINS.some(domain => apiBase.includes(domain));
    
    if (isMinimax) {
      apiBase = apiBase.replace('/anthropic', '').replace('/v1', '');
      apiBase = `${apiBase}/anthropic`;
    }

    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: apiBase,
    });
  }

  async generate(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string
  ): Promise<LLMResponse> {
    const preTrimSanitized = sanitizeMessagesForToolProtocol(messages);
    const trimmed = trimMessagesForContextWindow(preTrimSanitized.messages);
    // Trim may break tool_use -> tool_result adjacency; sanitize again after trim.
    const postTrimSanitized = sanitizeMessagesForToolProtocol(trimmed.messages);
    const anthropicMessages = this.convertMessages(postTrimSanitized.messages);
    
    const requestParams: Anthropic.Messages.MessageCreateParams = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: anthropicMessages,
    };

    if (systemPrompt) {
      requestParams.system = systemPrompt;
    }

    if (tools && tools.length > 0) {
      requestParams.tools = tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Messages.Tool['input_schema'],
      }));
    }

    try {
      const response = await this.client.messages.create(requestParams);
      return this.convertResponse(response);
    } catch (error) {
      if (!isMiniMaxContextWindowExceededError(error)) {
        throw error;
      }

      const retryTrimmed = trimMessagesForContextWindow(postTrimSanitized.messages, {
        maxTotalChars: Math.floor((trimmed.trimmedChars || DEFAULT_CONTEXT_MAX_CHARS) * 0.6),
        keepLatestCount: 12,
        maxToolChars: 2000,
        maxNonToolChars: 6000
      });
      const retrySanitized = sanitizeMessagesForToolProtocol(retryTrimmed.messages);
      const retryMessages = this.convertMessages(retrySanitized.messages);
      const retryRequestParams: Anthropic.Messages.MessageCreateParams = {
        ...requestParams,
        messages: retryMessages
      };
      const response = await this.client.messages.create(retryRequestParams);
      return this.convertResponse(response);
    }
  }

  async *generateStream(
    messages: Message[],
    tools?: ToolSchema[],
    systemPrompt?: string
  ): AsyncGenerator<{ type: string; data: unknown }, LLMResponse, unknown> {
    const preTrimSanitized = sanitizeMessagesForToolProtocol(messages);
    const trimmed = trimMessagesForContextWindow(preTrimSanitized.messages);
    // Trim may break tool_use -> tool_result adjacency; sanitize again after trim.
    const postTrimSanitized = sanitizeMessagesForToolProtocol(trimmed.messages);
    const anthropicMessages = this.convertMessages(postTrimSanitized.messages);
    
    const requestParams: Anthropic.Messages.MessageCreateParams = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: anthropicMessages,
    };

    if (systemPrompt) {
      requestParams.system = systemPrompt;
    }

    if (tools && tools.length > 0) {
      requestParams.tools = tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Messages.Tool['input_schema'],
      }));
    }

    const stream = this.client.messages.stream(requestParams);

    let content = '';
    let thinking = '';
    const toolCalls: ToolCall[] = [];
    let usage: TokenUsage | undefined;

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        
        if (delta.type === 'text_delta') {
          content += delta.text;
          yield { type: 'text', data: delta.text };
        } else if (delta.type === 'thinking_delta') {
          thinking += delta.thinking;
          yield { type: 'thinking', data: delta.thinking };
        } else if (delta.type === 'input_json_delta') {
          yield { type: 'tool_input', data: delta.partial_json };
        }
      } else if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          yield { type: 'tool_start', data: { id: block.id, name: block.name } };
        }
      } else if (event.type === 'message_start') {
        usage = {
          promptTokens: event.message.usage.input_tokens,
          completionTokens: 0,
          totalTokens: event.message.usage.input_tokens,
        };
      } else if (event.type === 'message_delta') {
        if (usage && event.usage) {
          usage.completionTokens = event.usage.output_tokens;
          usage.totalTokens = usage.promptTokens + usage.completionTokens;
        }
      }
    }

    const finalMessage = await stream.finalMessage();
    const response = this.convertResponse(finalMessage);

    yield { type: 'complete', data: response };
    return response;
  }

  async generateWithCallbacks(
    messages: Message[],
    callbacks: StreamCallbacks,
    tools?: ToolSchema[],
    systemPrompt?: string
  ): Promise<LLMResponse> {
    const generator = this.generateStream(messages, tools, systemPrompt);
    let finalResponse: LLMResponse | undefined;

    for await (const event of generator) {
      switch (event.type) {
        case 'text':
          callbacks.onText?.(event.data as string);
          break;
        case 'thinking':
          callbacks.onThinking?.(event.data as string);
          break;
        case 'tool_start':
          const toolStart = event.data as { id: string; name: string };
          callbacks.onToolUse?.(toolStart.id, toolStart.name, {});
          break;
        case 'complete':
          finalResponse = event.data as LLMResponse;
          callbacks.onComplete?.(finalResponse);
          break;
      }
    }

    return finalResponse!;
  }

  private convertMessages(messages: Message[]): Anthropic.Messages.MessageParam[] {
    return messages.map(msg => {
      if (msg.role === 'system') {
        return { role: 'user' as const, content: msg.content };
      }

      if (msg.role === 'tool') {
        return {
          role: 'user' as const,
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId ?? '',
              content: msg.content,
            },
          ],
        };
      }

      if (msg.role === 'assistant') {
        const content: Anthropic.Messages.ContentBlock[] = [];
        
        if (msg.thinking) {
          content.push({
            type: 'thinking',
            thinking: msg.thinking,
          } as Anthropic.Messages.ContentBlock);
        }

        if (typeof msg.content === 'string' && msg.content) {
          content.push({
            type: 'text',
            text: msg.content,
          } as Anthropic.Messages.ContentBlock);
        }

        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: tc.function.arguments,
            } as Anthropic.Messages.ContentBlock);
          }
        }

        return { role: 'assistant', content };
      }

      if (typeof msg.content === 'string') {
        return { role: 'user', content: msg.content };
      }

      return { role: 'user', content: msg.content };
    }) as Anthropic.Messages.MessageParam[];
  }

  private convertResponse(response: Anthropic.Messages.Message): LLMResponse {
    let content = '';
    let thinking: string | undefined;
    const toolCalls: ToolCall[] = [];
    let usage: TokenUsage | undefined;

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'thinking') {
        thinking = (block as any).thinking;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          },
        });
      }
    }

    if (response.usage) {
      usage = {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      };
    }

    return {
      content,
      thinking,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: response.stop_reason ?? 'end_turn',
      usage,
    };
  }
}
