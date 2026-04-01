import {
  selectTaskForDispatch,
  sortTasksForDispatch,
  type DispatchMessageLike,
  type DispatchTaskLike
} from "../../orchestrator-dispatch-core.js";

export interface ResolveOrchestratorDispatchCandidateInput<
  TTask extends DispatchTaskLike,
  TMessage extends DispatchMessageLike
> {
  messages: TMessage[];
  runnableTasks: TTask[];
  allTasks: TTask[];
  force: boolean;
  allowFallbackTask?: boolean;
  preferNonMayBeDoneOnFallback?: boolean;
  resolveTaskById(taskId: string): TTask | null;
}

export interface OrchestratorDispatchCandidate<TTask extends DispatchTaskLike, TMessage extends DispatchMessageLike> {
  dispatchKind: "task" | "message";
  taskId: string | null;
  task: TTask | null;
  selectedMessages: TMessage[];
  firstMessage: TMessage | null;
}

export function resolveOrchestratorDispatchCandidate<
  TTask extends DispatchTaskLike,
  TMessage extends DispatchMessageLike
>(
  input: ResolveOrchestratorDispatchCandidateInput<TTask, TMessage>
): OrchestratorDispatchCandidate<TTask, TMessage> | null {
  const prioritizedRunnableTasks = sortTasksForDispatch(input.runnableTasks, input.allTasks);
  const messageTaskSelection = selectTaskForDispatch(input.messages, input.runnableTasks, input.allTasks);

  if (messageTaskSelection) {
    const taskId = messageTaskSelection.taskId.length > 0 ? messageTaskSelection.taskId : null;
    const selectedMessages = messageTaskSelection.messages;
    return {
      dispatchKind: messageTaskSelection.dispatchKind,
      taskId,
      task: taskId ? input.resolveTaskById(taskId) : null,
      selectedMessages,
      firstMessage: selectedMessages[0] ?? null
    };
  }

  if (input.allowFallbackTask === false) {
    return null;
  }

  const fallbackTask =
    input.force || !input.preferNonMayBeDoneOnFallback
      ? (prioritizedRunnableTasks[0] ?? null)
      : (prioritizedRunnableTasks.find((task) => task.state !== "MAY_BE_DONE") ?? null);
  if (!fallbackTask) {
    return null;
  }
  const task = input.resolveTaskById(fallbackTask.taskId) ?? fallbackTask;
  return {
    dispatchKind: "task",
    taskId: task.taskId,
    task,
    selectedMessages: [],
    firstMessage: null
  };
}
