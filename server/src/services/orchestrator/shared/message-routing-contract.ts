import type { ManagerToAgentMessage, WorkflowManagerToAgentMessage } from "../../../domain/models.js";
import type { OrchestratorMessageScopeKind } from "./manager-message-contract.js";
import { buildOrchestratorManagerChatMessage } from "./manager-message-contract.js";

export interface BuildOrchestratorRoutedManagerMessageInput<
  TScopeKind extends OrchestratorMessageScopeKind = OrchestratorMessageScopeKind
> {
  scopeKind: TScopeKind;
  scopeId: string;
  fromAgent: string;
  fromSessionId: string;
  messageType: string;
  resolvedRole: string;
  requestId: string;
  messageId: string;
  createdAt: string;
  taskId?: string | null;
  content: string;
  parentRequestId?: string | null;
  discuss?: unknown | null;
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
