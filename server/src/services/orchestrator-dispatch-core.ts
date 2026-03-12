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
    const aTime = a.envelope.timestamp ? Date.parse(a.envelope.timestamp) : Number.NaN;
    const bTime = b.envelope.timestamp ? Date.parse(b.envelope.timestamp) : Number.NaN;
    const safeA = Number.isFinite(aTime) ? aTime : 0;
    const safeB = Number.isFinite(bTime) ? bTime : 0;
    return safeA - safeB;
  });
}

export function selectTaskForDispatch<TTask extends DispatchTaskLike, TMessage extends DispatchMessageLike>(
  undeliveredMessages: TMessage[],
  runnableTasks: TTask[],
  allTasks: TTask[]
): TaskDispatchSelection<TMessage> | null {
  const activeTaskStates = new Set(["DISPATCHED", "IN_PROGRESS"]);
  const runnableTaskIds = new Set(runnableTasks.map((task) => task.taskId));
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

  for (const [taskId, messages] of messagesByTask) {
    const hasAssignTask = messages.some((m) => isTaskAssignMessage(m));
    if (hasAssignTask && runnableTaskIds.has(taskId)) {
      return { taskId, messages: sortMessagesByTime(messages), dispatchKind: "task" };
    }

    const task = allTasks.find((item) => item.taskId === taskId);
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

  const sortedTasks = [...runnableTasks].sort((a, b) => {
    const aTime = Number.isFinite(Date.parse(a.createdAt ?? "")) ? Date.parse(a.createdAt ?? "") : 0;
    const bTime = Number.isFinite(Date.parse(b.createdAt ?? "")) ? Date.parse(b.createdAt ?? "") : 0;
    if (aTime !== bTime) {
      return aTime - bTime;
    }
    return a.taskId.localeCompare(b.taskId);
  });

  for (const task of sortedTasks) {
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
