import type {
  AccountabilityInfo,
  Envelope,
  ManagerChatMessageType,
  ManagerToAgentMessage,
  TaskSubtreePayload,
  WorkflowEnvelope,
  WorkflowManagerToAgentMessage
} from "../../../domain/models.js";

export type OrchestratorMessageScopeKind = "project" | "workflow";
type OrchestratorEnvelopeByScope<TScopeKind extends OrchestratorMessageScopeKind> = TScopeKind extends "project"
  ? Envelope
  : WorkflowEnvelope;
type OrchestratorManagerMessageByScope<TScopeKind extends OrchestratorMessageScopeKind> = TScopeKind extends "project"
  ? ManagerToAgentMessage
  : WorkflowManagerToAgentMessage;

export interface BuildOrchestratorMessageEnvelopeInput<
  TScopeKind extends OrchestratorMessageScopeKind = OrchestratorMessageScopeKind
> {
  scopeKind: TScopeKind;
  scopeId: string;
  messageId: string;
  createdAt: string;
  senderType: "agent" | "user" | "system";
  senderRole: string;
  senderSessionId: string;
  intent: string;
  requestId: string;
  parentRequestId?: string | null;
  taskId?: string | null;
  ownerRole: string;
  reportToRole: string;
  reportToSessionId?: string;
  expect: AccountabilityInfo["expect"];
  priority?: Envelope["priority"];
  dispatchPolicy?: Envelope["dispatch_policy"];
}

export interface BuildOrchestratorChatMessageBodyInput {
  messageType: ManagerChatMessageType;
  content: string;
  taskId?: string | null;
  discuss?: unknown | null;
}

export interface OrchestratorDiscussReference {
  threadId?: string;
  requestId?: string;
}

export interface OrchestratorRouteMessageInputBase {
  fromAgent: string;
  fromSessionId: string;
  messageType: ManagerChatMessageType;
  toRole?: string;
  toSessionId?: string;
  taskId?: string;
  content: string;
  requestId?: string;
  parentRequestId?: string;
  discuss?: OrchestratorDiscussReference;
}

export function normalizeOrchestratorDiscussReference(value: unknown): OrchestratorDiscussReference | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const threadIdRaw = record.threadId ?? record.thread_id;
  const requestIdRaw = record.requestId ?? record.request_id;
  const threadId = typeof threadIdRaw === "string" && threadIdRaw.trim().length > 0 ? threadIdRaw.trim() : undefined;
  const requestId =
    typeof requestIdRaw === "string" && requestIdRaw.trim().length > 0 ? requestIdRaw.trim() : undefined;
  if (!threadId && !requestId) {
    return null;
  }
  return { threadId, requestId };
}

export interface BuildOrchestratorManagerChatMessageInput
  extends BuildOrchestratorMessageEnvelopeInput, BuildOrchestratorChatMessageBodyInput {}

export interface BuildOrchestratorTaskAssignmentBodyInput {
  assignmentTaskId: string;
  title: string;
  summary?: string;
  task: {
    taskId: string;
    taskKind?: string;
    parentTaskId: string | null;
    rootTaskId?: string;
    state?: string;
    ownerRole: string;
    ownerSession?: string | null;
    priority?: number;
    writeSet?: string[];
    dependencies?: string[];
    acceptance?: string[];
    artifacts?: string[];
  };
  taskSubtree?: TaskSubtreePayload | null;
}

export interface BuildOrchestratorTaskAssignmentMessageInput
  extends BuildOrchestratorMessageEnvelopeInput, BuildOrchestratorTaskAssignmentBodyInput {}

export interface BuildOrchestratorRoutedManagerMessageInput<
  TScopeKind extends OrchestratorMessageScopeKind = OrchestratorMessageScopeKind
> {
  scopeKind: TScopeKind;
  scopeId: string;
  fromAgent: string;
  fromSessionId: string;
  messageType: ManagerChatMessageType;
  resolvedRole: string;
  requestId: string;
  messageId: string;
  createdAt: string;
  taskId?: string | null;
  content: string;
  parentRequestId?: string | null;
  discuss?: unknown | null;
}

export function buildOrchestratorMessageEnvelope(input: BuildOrchestratorMessageEnvelopeInput<"project">): Envelope;
export function buildOrchestratorMessageEnvelope(
  input: BuildOrchestratorMessageEnvelopeInput<"workflow">
): WorkflowEnvelope;
export function buildOrchestratorMessageEnvelope(
  input: BuildOrchestratorMessageEnvelopeInput
): Envelope | WorkflowEnvelope;
export function buildOrchestratorMessageEnvelope<TScopeKind extends OrchestratorMessageScopeKind>(
  input: BuildOrchestratorMessageEnvelopeInput<TScopeKind>
): OrchestratorEnvelopeByScope<TScopeKind> {
  const base = {
    message_id: input.messageId,
    timestamp: input.createdAt,
    sender: {
      type: input.senderType,
      role: input.senderRole,
      session_id: input.senderSessionId
    },
    via: { type: "manager" as const },
    intent: input.intent,
    priority: input.priority ?? "normal",
    correlation: {
      request_id: input.requestId,
      parent_request_id: input.parentRequestId ?? undefined,
      task_id: input.taskId ?? undefined
    },
    accountability: {
      owner_role: input.ownerRole,
      report_to: {
        role: input.reportToRole,
        session_id: input.reportToSessionId
      },
      expect: input.expect
    },
    dispatch_policy: input.dispatchPolicy ?? "fixed_session"
  };
  if (input.scopeKind === "project") {
    return {
      ...base,
      project_id: input.scopeId
    } as OrchestratorEnvelopeByScope<TScopeKind>;
  }
  return {
    ...base,
    run_id: input.scopeId
  } as OrchestratorEnvelopeByScope<TScopeKind>;
}

export function buildOrchestratorChatMessageBody(
  input: BuildOrchestratorChatMessageBodyInput
): Record<string, unknown> {
  return {
    messageType: input.messageType,
    mode: "CHAT",
    content: input.content,
    taskId: input.taskId ?? null,
    discuss: input.discuss ?? null
  };
}

export function buildOrchestratorManagerChatMessage(
  input: BuildOrchestratorManagerChatMessageInput & { scopeKind: "project" }
): ManagerToAgentMessage;
export function buildOrchestratorManagerChatMessage(
  input: BuildOrchestratorManagerChatMessageInput & { scopeKind: "workflow" }
): WorkflowManagerToAgentMessage;
export function buildOrchestratorManagerChatMessage(
  input: BuildOrchestratorManagerChatMessageInput
): ManagerToAgentMessage | WorkflowManagerToAgentMessage;
export function buildOrchestratorManagerChatMessage<TScopeKind extends OrchestratorMessageScopeKind>(
  input: BuildOrchestratorManagerChatMessageInput & { scopeKind: TScopeKind }
): OrchestratorManagerMessageByScope<TScopeKind> {
  return {
    envelope: buildOrchestratorMessageEnvelope(input),
    body: buildOrchestratorChatMessageBody(input)
  } as OrchestratorManagerMessageByScope<TScopeKind>;
}

export function buildOrchestratorRoutedManagerMessage(
  input: BuildOrchestratorRoutedManagerMessageInput<"project">
): ManagerToAgentMessage;
export function buildOrchestratorRoutedManagerMessage(
  input: BuildOrchestratorRoutedManagerMessageInput<"workflow">
): WorkflowManagerToAgentMessage;
export function buildOrchestratorRoutedManagerMessage(
  input: BuildOrchestratorRoutedManagerMessageInput
): ManagerToAgentMessage | WorkflowManagerToAgentMessage;
export function buildOrchestratorRoutedManagerMessage(
  input: BuildOrchestratorRoutedManagerMessageInput
): ManagerToAgentMessage | WorkflowManagerToAgentMessage {
  const fromAgent = input.fromAgent.trim() || "manager";
  return buildOrchestratorManagerChatMessage({
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    messageId: input.messageId,
    createdAt: input.createdAt,
    senderType: fromAgent === "manager" ? "system" : "agent",
    senderRole: fromAgent,
    senderSessionId: input.fromSessionId,
    intent: input.messageType.startsWith("TASK_DISCUSS") ? "TASK_DISCUSS" : "MANAGER_MESSAGE",
    requestId: input.requestId,
    parentRequestId: input.parentRequestId,
    taskId: input.taskId,
    ownerRole: input.resolvedRole,
    reportToRole: fromAgent,
    reportToSessionId: input.fromSessionId,
    expect: input.messageType === "TASK_DISCUSS_REQUEST" ? "DISCUSS_REPLY" : "TASK_REPORT",
    messageType: input.messageType,
    content: input.content,
    discuss: input.discuss ?? null
  });
}

function buildOrchestratorTaskAssignmentBody(input: BuildOrchestratorTaskAssignmentBodyInput): Record<string, unknown> {
  return {
    messageType: "TASK_ASSIGNMENT",
    mode: "CHAT",
    taskId: input.assignmentTaskId,
    title: input.title,
    summary: input.summary ?? "",
    task: {
      task_id: input.task.taskId,
      task_kind: input.task.taskKind,
      parent_task_id: input.task.parentTaskId,
      root_task_id: input.task.rootTaskId,
      state: input.task.state,
      owner_role: input.task.ownerRole,
      owner_session: input.task.ownerSession ?? null,
      priority: input.task.priority ?? 0,
      write_set: input.task.writeSet ?? [],
      dependencies: input.task.dependencies ?? [],
      acceptance: input.task.acceptance ?? [],
      artifacts: input.task.artifacts ?? []
    },
    task_subtree: input.taskSubtree ?? null
  };
}

export function buildOrchestratorTaskAssignmentMessage(
  input: BuildOrchestratorTaskAssignmentMessageInput & { scopeKind: "project" }
): ManagerToAgentMessage;
export function buildOrchestratorTaskAssignmentMessage(
  input: BuildOrchestratorTaskAssignmentMessageInput & { scopeKind: "workflow" }
): WorkflowManagerToAgentMessage;
export function buildOrchestratorTaskAssignmentMessage(
  input: BuildOrchestratorTaskAssignmentMessageInput
): ManagerToAgentMessage | WorkflowManagerToAgentMessage;
export function buildOrchestratorTaskAssignmentMessage<TScopeKind extends OrchestratorMessageScopeKind>(
  input: BuildOrchestratorTaskAssignmentMessageInput & { scopeKind: TScopeKind }
): OrchestratorManagerMessageByScope<TScopeKind> {
  return {
    envelope: buildOrchestratorMessageEnvelope(input),
    body: buildOrchestratorTaskAssignmentBody(input)
  } as OrchestratorManagerMessageByScope<TScopeKind>;
}
