import { getRoleMessageStatus } from "../../data/role-message-status-store.js";
import type { ManagerToAgentMessage, ProjectRecord, TaskRecord } from "../../domain/models.js";
import { extractTaskIdFromMessage } from "../orchestrator-dispatch-core.js";
import { resolveOrchestratorDispatchCandidate } from "./shared/index.js";
import type { DispatchKind } from "./project-orchestrator-types.js";

export interface ResolveProjectDispatchMessageSelectionInput {
  project: ProjectRecord;
  role: string;
  allTasks: TaskRecord[];
  runnableTasks: TaskRecord[];
  inboxMessages: ManagerToAgentMessage[];
  messageId?: string;
  force: boolean;
}

export interface ProjectDispatchMessageSelectionResult {
  selectedMessages: ManagerToAgentMessage[];
  selectedTaskId: string;
  dispatchKind: DispatchKind;
  selectedTask: TaskRecord | null;
}

export function resolveProjectDispatchMessageSelection(
  input: ResolveProjectDispatchMessageSelectionInput
): ProjectDispatchMessageSelectionResult {
  const explicitMessageCandidate = input.messageId
    ? (input.inboxMessages.find((item) => item.envelope.message_id === input.messageId) ?? null)
    : null;
  const roleStatus = getRoleMessageStatus(input.project, input.role);
  const confirmedIds = new Set(roleStatus.confirmedMessageIds);
  const pendingIds = new Set(roleStatus.pendingConfirmedMessages.map((item) => item.messageId));
  const undeliveredMessages = input.messageId
    ? []
    : input.inboxMessages
        .filter((item) => !confirmedIds.has(item.envelope.message_id) && !pendingIds.has(item.envelope.message_id))
        .sort((a, b) => {
          const aTime = a.envelope.timestamp ? new Date(a.envelope.timestamp).getTime() : 0;
          const bTime = b.envelope.timestamp ? new Date(b.envelope.timestamp).getTime() : 0;
          return aTime - bTime;
        });

  if (explicitMessageCandidate) {
    const selectedTaskId = extractTaskIdFromMessage(explicitMessageCandidate) ?? "";
    return {
      selectedMessages: [explicitMessageCandidate],
      selectedTaskId,
      dispatchKind: "message",
      selectedTask: selectedTaskId ? (input.allTasks.find((item) => item.taskId === selectedTaskId) ?? null) : null
    };
  }

  const messageCandidate = resolveOrchestratorDispatchCandidate({
    messages: undeliveredMessages,
    runnableTasks: input.runnableTasks,
    allTasks: input.allTasks,
    force: input.force,
    allowFallbackTask: false,
    resolveTaskById: (taskId) => input.allTasks.find((item) => item.taskId === taskId) ?? null
  });
  if (!messageCandidate) {
    return {
      selectedMessages: [],
      selectedTaskId: "",
      dispatchKind: null,
      selectedTask: null
    };
  }
  return {
    selectedMessages: messageCandidate.selectedMessages,
    selectedTaskId: messageCandidate.taskId ?? "",
    dispatchKind: messageCandidate.dispatchKind,
    selectedTask: messageCandidate.task
  };
}
