type MessageMode = "CHAT";

function withExtras(base: Record<string, unknown>, extras?: Record<string, unknown>): Record<string, unknown> {
  if (!extras) {
    return base;
  }
  return {
    ...base,
    ...extras
  };
}

export interface UserMessageReceivedPayloadInput {
  requestId: string;
  parentRequestId?: string | null;
  content: string;
  toRole?: string | null;
  fromAgent: string;
  mode: MessageMode;
  messageType: string;
  taskId?: string | null;
  discuss?: unknown | null;
  extras?: Record<string, unknown>;
}

export function buildUserMessageReceivedPayload(input: UserMessageReceivedPayloadInput): Record<string, unknown> {
  return withExtras(
    {
      requestId: input.requestId,
      parentRequestId: input.parentRequestId ?? null,
      content: input.content,
      toRole: input.toRole ?? null,
      fromAgent: input.fromAgent,
      mode: input.mode,
      messageType: input.messageType,
      taskId: input.taskId ?? null,
      discuss: input.discuss ?? null
    },
    input.extras
  );
}

export interface MessageRoutedPayloadInput {
  requestId: string;
  parentRequestId?: string | null;
  toRole?: string | null;
  resolvedSessionId: string;
  messageId: string;
  mode: MessageMode;
  messageType: string;
  taskId?: string | null;
  discuss?: unknown | null;
  content: string;
  extras?: Record<string, unknown>;
}

export function buildMessageRoutedPayload(input: MessageRoutedPayloadInput): Record<string, unknown> {
  return withExtras(
    {
      requestId: input.requestId,
      parentRequestId: input.parentRequestId ?? null,
      toRole: input.toRole ?? null,
      resolvedSessionId: input.resolvedSessionId,
      messageId: input.messageId,
      mode: input.mode,
      messageType: input.messageType,
      taskId: input.taskId ?? null,
      discuss: input.discuss ?? null,
      content: input.content
    },
    input.extras
  );
}

export interface ManagerMessageRoutedPayloadInput {
  messageId: string;
  toSessionId: string;
  toRole?: string | null;
  type: string;
  mode?: MessageMode;
  requestId?: string | null;
  content?: string;
  extras?: Record<string, unknown>;
}

export function buildManagerMessageRoutedPayload(input: ManagerMessageRoutedPayloadInput): Record<string, unknown> {
  return withExtras(
    {
      messageId: input.messageId,
      toSessionId: input.toSessionId,
      toRole: input.toRole ?? null,
      type: input.type,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(typeof input.content === "string" ? { content: input.content } : {})
    },
    input.extras
  );
}
