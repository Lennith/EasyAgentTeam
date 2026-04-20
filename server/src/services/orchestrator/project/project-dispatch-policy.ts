import type { ManagerToAgentMessage, SessionRecord, TaskRecord } from "../../../domain/models.js";
import { getTaskDependencyGateStatus } from "../../../data/repository/project/taskboard-repository.js";
import { extractTaskIdFromMessage, isDiscussMessage } from "../../orchestrator-dispatch-core.js";
import { isTerminalTaskState } from "./project-completion-policy.js";
import { buildRoleScopedSessionId } from "../shared/orchestrator-identifiers.js";

export function isPendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith("pending-");
}

export function buildPendingSessionId(role: string): string {
  return buildRoleScopedSessionId(role);
}

export function isForceDispatchableState(state: string): boolean {
  return state === "READY" || state === "DISPATCHED" || state === "IN_PROGRESS";
}

export function sessionMatchesOwnerToken(session: SessionRecord, ownerSessionToken: string | undefined): boolean {
  if (!ownerSessionToken) {
    return false;
  }
  return session.sessionId === ownerSessionToken;
}

export function areTaskDependenciesSatisfied(
  task: TaskRecord,
  allTasks: TaskRecord[]
): {
  satisfied: boolean;
  unsatisfiedDeps: string[];
  blockingTaskIds: string[];
} {
  const byId = new Map(allTasks.map((item) => [item.taskId, item]));
  const gate = getTaskDependencyGateStatus(task, byId);
  return {
    satisfied: gate.satisfied,
    unsatisfiedDeps: gate.unsatisfiedDependencyIds,
    blockingTaskIds: gate.blockingTaskIds
  };
}

function findCorrectTask(wrongTask: TaskRecord, targetRole: string, allTasks: TaskRecord[]): TaskRecord | null {
  const childTasks = allTasks.filter(
    (task) =>
      task.taskId !== wrongTask.taskId && task.parentTaskId === wrongTask.taskId && !isTerminalTaskState(task.state)
  );
  const wrongOwner = wrongTask.ownerRole;
  const wrongCreator = wrongTask.creatorRole;
  for (const child of childTasks) {
    const ownerMatch = child.ownerRole === wrongOwner || child.ownerRole === wrongCreator;
    const creatorMatch = child.creatorRole === wrongOwner || child.creatorRole === wrongCreator;
    const different = child.ownerRole !== child.creatorRole;
    const targetMatch = child.ownerRole === targetRole || child.creatorRole === targetRole;
    if (ownerMatch && creatorMatch && different && targetMatch) {
      return child;
    }
  }
  return null;
}

function findDependentDiscussTask(
  wrongTask: TaskRecord,
  targetRole: string,
  allTasks: TaskRecord[]
): TaskRecord | null {
  const candidates = allTasks
    .filter(
      (task) =>
        task.taskId !== wrongTask.taskId &&
        task.ownerRole === targetRole &&
        task.rootTaskId === wrongTask.rootTaskId &&
        !isTerminalTaskState(task.state) &&
        task.dependencies.includes(wrongTask.taskId)
    )
    .sort((a, b) => {
      const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      const createdAtDiff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
      if (Number.isFinite(createdAtDiff) && createdAtDiff !== 0) {
        return createdAtDiff;
      }
      return a.taskId.localeCompare(b.taskId);
    });
  return candidates[0] ?? null;
}

export function resolveTaskDiscuss(
  message: ManagerToAgentMessage,
  targetRole: string,
  allTasks: TaskRecord[]
): ManagerToAgentMessage {
  if (!isDiscussMessage(message)) {
    return message;
  }
  const wrongTaskId = extractTaskIdFromMessage(message);
  if (!wrongTaskId) {
    return message;
  }
  const wrongTask = allTasks.find((task) => task.taskId === wrongTaskId);
  if (!wrongTask || wrongTask.ownerRole === targetRole) {
    return message;
  }
  const correctTask =
    findCorrectTask(wrongTask, targetRole, allTasks) ?? findDependentDiscussTask(wrongTask, targetRole, allTasks);
  if (!correctTask) {
    return message;
  }
  return {
    ...message,
    envelope: {
      ...message.envelope,
      correlation: {
        ...message.envelope.correlation,
        task_id: correctTask.taskId
      }
    },
    body: {
      ...message.body,
      taskId: correctTask.taskId
    }
  };
}
