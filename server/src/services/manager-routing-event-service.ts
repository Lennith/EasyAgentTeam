type MessageMode = "CHAT";

interface UserMessageReceivedPayloadBase {
  requestId: string;
  parentRequestId: string | null;
  content: string;
  toRole: string | null;
  fromAgent: string;
}

interface MessageRoutedPayloadBase {
  requestId: string;
  parentRequestId: string | null;
  toRole: string | null;
  resolvedSessionId: string;
  messageId: string;
  content: string;
}

function withExtras(base: Record<string, unknown>, extras?: Record<string, unknown>): Record<string, unknown> {
  if (!extras) {
    return base;
  }
  return {
    ...base,
    ...extras
  };
}

function buildWorkflowRouteSourceMetadata(fromAgent: string): Record<string, unknown> {
  return {
    sourceType: fromAgent === "manager" ? "manager" : "agent",
    originAgent: fromAgent
  };
}

function buildUserMessageReceivedPayloadBase(input: {
  requestId: string;
  parentRequestId?: string | null;
  content: string;
  toRole?: string | null;
  fromAgent: string;
}): UserMessageReceivedPayloadBase {
  return {
    requestId: input.requestId,
    parentRequestId: input.parentRequestId ?? null,
    content: input.content,
    toRole: input.toRole ?? null,
    fromAgent: input.fromAgent
  };
}

function buildMessageRoutedPayloadBase(input: {
  requestId: string;
  parentRequestId?: string | null;
  toRole?: string | null;
  resolvedSessionId: string;
  messageId: string;
  content: string;
}): MessageRoutedPayloadBase {
  return {
    requestId: input.requestId,
    parentRequestId: input.parentRequestId ?? null,
    toRole: input.toRole ?? null,
    resolvedSessionId: input.resolvedSessionId,
    messageId: input.messageId,
    content: input.content
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
      ...buildUserMessageReceivedPayloadBase(input),
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
      ...buildMessageRoutedPayloadBase(input),
      mode: input.mode,
      messageType: input.messageType,
      taskId: input.taskId ?? null,
      discuss: input.discuss ?? null
    },
    input.extras
  );
}

export interface WorkflowMessageReceivedPayloadInput {
  requestId: string;
  content: string;
  toRole: string;
  fromAgent: string;
}

export function buildWorkflowMessageReceivedPayload(
  input: WorkflowMessageReceivedPayloadInput
): Record<string, unknown> {
  const base = buildUserMessageReceivedPayloadBase(input);
  return {
    fromAgent: base.fromAgent,
    toRole: base.toRole,
    requestId: base.requestId,
    content: base.content,
    ...buildWorkflowRouteSourceMetadata(input.fromAgent)
  };
}

export interface WorkflowMessageRoutedPayloadInput {
  fromAgent: string;
  toRole: string;
  resolvedSessionId: string;
  requestId: string;
  messageId: string;
  content: string;
  messageType: string;
  discuss: unknown | null;
}

export function buildWorkflowMessageRoutedPayload(input: WorkflowMessageRoutedPayloadInput): Record<string, unknown> {
  const base = buildMessageRoutedPayloadBase(input);
  return {
    fromAgent: input.fromAgent,
    toRole: base.toRole,
    resolvedSessionId: base.resolvedSessionId,
    requestId: base.requestId,
    messageId: base.messageId,
    content: base.content,
    messageType: input.messageType,
    discuss: input.discuss ?? null,
    ...buildWorkflowRouteSourceMetadata(input.fromAgent)
  };
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
