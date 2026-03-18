export interface DispatchMessageLike {
  envelope: {
    timestamp?: string;
    intent?: string;
    correlation?: {
      task_id?: string;
    };
  };
  body: Record<string, unknown>;
}

export interface DispatchTaskLike {
  taskId: string;
  state: string;
  createdAt?: string;
  parentTaskId?: string;
  priority?: number;
}

export interface TaskDispatchSelection<TMessage extends DispatchMessageLike> {
  taskId: string;
  messages: TMessage[];
  dispatchKind: "task" | "message";
}

const REMINDABLE_TASK_STATES = new Set(["READY", "DISPATCHED", "IN_PROGRESS", "MAY_BE_DONE"]);

export function extractTaskIdFromMessage<TMessage extends DispatchMessageLike>(message: TMessage): string | undefined {
  const payload = message.body ?? {};
  const fromPayload = payload.taskId;
  if (typeof fromPayload === "string" && fromPayload.trim().length > 0) {
    return fromPayload.trim();
  }
  return message.envelope.correlation?.task_id;
}

export function readMessageTypeUpper<TMessage extends DispatchMessageLike>(message: TMessage): string {
  const bodyType = (message.body as Record<string, unknown>).messageType;
  if (typeof bodyType === "string" && bodyType.trim().length > 0) {
    return bodyType.trim().toUpperCase();
  }
  const intent = message.envelope.intent;
  return typeof intent === "string" ? intent.toUpperCase() : "";
}

export function isDiscussMessage<TMessage extends DispatchMessageLike>(message: TMessage): boolean {
  return readMessageTypeUpper(message).startsWith("TASK_DISCUSS");
}

export function isTaskAssignMessage<TMessage extends DispatchMessageLike>(message: TMessage): boolean {
  return readMessageTypeUpper(message) === "TASK_ASSIGNMENT";
}

export function isRemindableTaskState(state: string | null | undefined): boolean {
  if (typeof state !== "string") return false;
  return REMINDABLE_TASK_STATES.has(state.trim().toUpperCase());
}

export function sortMessagesByTime<TMessage extends DispatchMessageLike>(messages: TMessage[]): TMessage[] {
  return [...messages].sort((a, b) => {
    const safeA = parseIsoMs(a.envelope.timestamp);
    const safeB = parseIsoMs(b.envelope.timestamp);
    return safeA - safeB;
  });
}

function parseIsoMs(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePriority(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.floor(value ?? 0);
}

function normalizeParentTaskId(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function computeTaskDepth(
  taskId: string,
  parentByTaskId: Map<string, string | undefined>,
  memo: Map<string, number>,
  visiting: Set<string>
): number {
  const cached = memo.get(taskId);
  if (cached !== undefined) {
    return cached;
  }
  if (visiting.has(taskId)) {
    return 0;
  }
  visiting.add(taskId);
  const parentTaskId = parentByTaskId.get(taskId);
  if (!parentTaskId || parentTaskId === taskId || !parentByTaskId.has(parentTaskId)) {
    visiting.delete(taskId);
    memo.set(taskId, 0);
    return 0;
  }
  const depth = computeTaskDepth(parentTaskId, parentByTaskId, memo, visiting) + 1;
  visiting.delete(taskId);
  memo.set(taskId, depth);
  return depth;
}

export function sortTasksForDispatch<TTask extends DispatchTaskLike>(
  candidateTasks: TTask[],
  allTasks: TTask[]
): TTask[] {
  if (candidateTasks.length <= 1) {
    return [...candidateTasks];
  }
  const parentByTaskId = new Map<string, string | undefined>();
  for (const task of allTasks) {
    if (!parentByTaskId.has(task.taskId)) {
      parentByTaskId.set(task.taskId, normalizeParentTaskId(task.parentTaskId));
    }
  }
  for (const task of candidateTasks) {
    if (!parentByTaskId.has(task.taskId)) {
      parentByTaskId.set(task.taskId, normalizeParentTaskId(task.parentTaskId));
    }
  }
  const depthMemo = new Map<string, number>();
  const sorted = [...candidateTasks].sort((a, b) => {
    const depthA = computeTaskDepth(a.taskId, parentByTaskId, depthMemo, new Set<string>());
    const depthB = computeTaskDepth(b.taskId, parentByTaskId, depthMemo, new Set<string>());
    if (depthA !== depthB) {
      return depthB - depthA;
    }
    const priorityA = normalizePriority(a.priority);
    const priorityB = normalizePriority(b.priority);
    if (priorityA !== priorityB) {
      return priorityB - priorityA;
    }
    const createdAtA = parseIsoMs(a.createdAt);
    const createdAtB = parseIsoMs(b.createdAt);
    if (createdAtA !== createdAtB) {
      return createdAtA - createdAtB;
    }
    return a.taskId.localeCompare(b.taskId);
  });
  return sorted;
}

function findEarliestMessageMs<TMessage extends DispatchMessageLike>(messages: TMessage[]): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const message of messages) {
    const current = parseIsoMs(message.envelope.timestamp);
    if (current < earliest) {
      earliest = current;
    }
  }
  if (!Number.isFinite(earliest)) {
    return 0;
  }
  return earliest;
}

export function selectTaskForDispatch<TTask extends DispatchTaskLike, TMessage extends DispatchMessageLike>(
  undeliveredMessages: TMessage[],
  runnableTasks: TTask[],
  allTasks: TTask[]
): TaskDispatchSelection<TMessage> | null {
  const activeTaskStates = new Set(["DISPATCHED", "IN_PROGRESS"]);
  const runnableTaskIds = new Set(runnableTasks.map((task) => task.taskId));
  const runnableTaskById = new Map(runnableTasks.map((task) => [task.taskId, task]));
  const allTaskById = new Map(allTasks.map((task) => [task.taskId, task]));
  const messagesByTask = new Map<string, TMessage[]>();
  const messagesWithoutTask: TMessage[] = [];

  for (const msg of undeliveredMessages) {
    const taskId = extractTaskIdFromMessage(msg);
    if (taskId) {
      if (!messagesByTask.has(taskId)) {
        messagesByTask.set(taskId, []);
      }
      messagesByTask.get(taskId)!.push(msg);
      continue;
    }
    messagesWithoutTask.push(msg);
  }

  const prioritizedRunnableTasks = sortTasksForDispatch(runnableTasks, allTasks);
  const assignCandidate = prioritizedRunnableTasks.find((task) => {
    const taskMessages = messagesByTask.get(task.taskId);
    return Boolean(taskMessages && taskMessages.some((item) => isTaskAssignMessage(item)));
  });
  if (assignCandidate) {
    const messages = messagesByTask.get(assignCandidate.taskId) ?? [];
    return { taskId: assignCandidate.taskId, messages: sortMessagesByTime(messages), dispatchKind: "task" };
  }

  const messageTaskIds = Array.from(messagesByTask.keys()).sort((a, b) => {
    const aMs = findEarliestMessageMs(messagesByTask.get(a) ?? []);
    const bMs = findEarliestMessageMs(messagesByTask.get(b) ?? []);
    if (aMs !== bMs) {
      return aMs - bMs;
    }
    return a.localeCompare(b);
  });

  for (const taskId of messageTaskIds) {
    const messages = messagesByTask.get(taskId) ?? [];
    const hasAssignTask = messages.some((m) => isTaskAssignMessage(m));
    if (hasAssignTask && runnableTaskIds.has(taskId)) {
      const runnableTask = runnableTaskById.get(taskId);
      if (runnableTask) {
        return { taskId: runnableTask.taskId, messages: sortMessagesByTime(messages), dispatchKind: "task" };
      }
    }

    const task = allTaskById.get(taskId);
    if (!task || !activeTaskStates.has(task.state)) {
      continue;
    }

    const hasDiscuss = messages.some((m) => isDiscussMessage(m));
    if (hasDiscuss) {
      return { taskId, messages: sortMessagesByTime(messages), dispatchKind: "message" };
    }

    const hasTaskBoundMessage = messages.some((m) => !isTaskAssignMessage(m));
    if (hasTaskBoundMessage) {
      return { taskId, messages: sortMessagesByTime(messages), dispatchKind: "message" };
    }
  }

  for (const task of prioritizedRunnableTasks) {
    const messages = messagesByTask.get(task.taskId);
    if (messages && messages.length > 0) {
      const hasTaskAssign = messages.some((m) => isTaskAssignMessage(m));
      return {
        taskId: task.taskId,
        messages: sortMessagesByTime(messages),
        dispatchKind: hasTaskAssign ? "task" : "message"
      };
    }
  }

  if (messagesWithoutTask.length > 0) {
    return { taskId: "", messages: sortMessagesByTime(messagesWithoutTask), dispatchKind: "message" };
  }

  return null;
}
