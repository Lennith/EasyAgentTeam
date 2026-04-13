import type {
  TaskSubtreePayload,
  WorkflowManagerToAgentMessage,
  WorkflowRunRecord,
  WorkflowTaskRuntimeRecord,
  WorkflowTaskState
} from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import {
  extractTaskIdFromMessage,
  readMessageTypeUpper,
  sortMessagesByTime
} from "../../orchestrator-dispatch-core.js";
import {
  buildOrchestratorTaskAssignmentMessage,
  buildOrchestratorTaskSubtreePayload,
  buildOrchestratorTaskSubtreeSummary,
  resolveOrchestratorDispatchCandidate
} from "../shared/index.js";

interface WorkflowRoleTaskCandidate {
  taskId: string;
  state: WorkflowTaskState;
  createdAt: string;
  parentTaskId?: string;
  priority?: number;
}

export interface WorkflowDispatchRoleSelectionInput {
  repositories: WorkflowRepositoryBundle;
  run: WorkflowRunRecord;
  runtimeTaskById: Map<string, WorkflowTaskRuntimeRecord>;
  role: string;
  taskFilter?: string;
  force: boolean;
}

export interface WorkflowDispatchRoleSelectionResult {
  taskId: string | null;
  dispatchKind: "task" | "message";
  message: WorkflowManagerToAgentMessage | null;
  selectedMessageIds: string[];
  runtimeTask: WorkflowTaskRuntimeRecord | null;
}

function isAutomaticTaskRedispatchSource(message: WorkflowManagerToAgentMessage, focusTaskId: string): boolean {
  const body = message.body as Record<string, unknown>;
  if ((extractTaskIdFromMessage(message) ?? "") !== focusTaskId) {
    return false;
  }
  const messageType = readMessageTypeUpper(message);
  if (messageType === "TASK_ASSIGNMENT" || messageType === "TASK_CREATOR_TERMINAL_REPORT") {
    return true;
  }
  return messageType === "MANAGER_MESSAGE" && typeof body.reminder === "object" && body.reminder !== null;
}

function buildWorkflowTaskSubtree(
  run: WorkflowRunRecord,
  runtimeTaskById: Map<string, WorkflowTaskRuntimeRecord>,
  focusTaskId: string
): TaskSubtreePayload {
  return buildOrchestratorTaskSubtreePayload(
    focusTaskId,
    run.tasks.map((task) => {
      const runtimeTask = runtimeTaskById.get(task.taskId);
      return {
        taskId: task.taskId,
        parentTaskId: task.parentTaskId ?? null,
        state: runtimeTask?.state ?? "PLANNED",
        ownerRole: task.ownerRole,
        ownerSession: null,
        closeReportId: null,
        lastSummary: runtimeTask?.lastSummary ?? null
      };
    })
  );
}

function buildSyntheticWorkflowTaskMessage(
  input: WorkflowDispatchRoleSelectionInput,
  taskId: string,
  sourceMessages: WorkflowManagerToAgentMessage[]
): WorkflowManagerToAgentMessage | null {
  const task = input.run.tasks.find((item) => item.taskId === taskId);
  const runtimeTask = input.runtimeTaskById.get(taskId);
  if (!task || !runtimeTask) {
    return null;
  }
  const firstSourceMessage = sourceMessages[0];
  const taskSubtree = buildWorkflowTaskSubtree(input.run, input.runtimeTaskById, taskId);
  return buildOrchestratorTaskAssignmentMessage({
    scopeKind: "workflow",
    scopeId: input.run.runId,
    messageId: `synthetic-${taskId}-${Date.now()}`,
    createdAt: new Date().toISOString(),
    senderType: "system",
    senderRole: "manager",
    senderSessionId: "manager-system",
    intent: "TASK_ASSIGNMENT",
    requestId: firstSourceMessage?.envelope.correlation.request_id ?? `workflow-dispatch-${taskId}`,
    parentRequestId: firstSourceMessage?.envelope.correlation.parent_request_id ?? undefined,
    taskId,
    ownerRole: input.role,
    reportToRole: "manager",
    reportToSessionId: "manager-system",
    expect: "TASK_REPORT",
    assignmentTaskId: taskId,
    title: task.resolvedTitle,
    summary: buildOrchestratorTaskSubtreeSummary(taskSubtree, runtimeTask.lastSummary),
    task: {
      taskId,
      parentTaskId: task.parentTaskId ?? null,
      rootTaskId: undefined,
      state: runtimeTask.state,
      ownerRole: task.ownerRole,
      ownerSession: null,
      priority: 0,
      writeSet: task.writeSet ?? [],
      dependencies: task.dependencies ?? [],
      acceptance: task.acceptance ?? [],
      artifacts: task.artifacts ?? []
    },
    taskSubtree
  }) as WorkflowManagerToAgentMessage;
}

function buildWorkflowRoleTaskCandidates(input: WorkflowDispatchRoleSelectionInput): WorkflowRoleTaskCandidate[] {
  const { run, runtimeTaskById, role, taskFilter } = input;
  return run.tasks
    .filter((task) => task.ownerRole === role)
    .filter((task) => !taskFilter || task.taskId === taskFilter)
    .reduce<WorkflowRoleTaskCandidate[]>((accumulator, task) => {
      const runtimeTask = runtimeTaskById.get(task.taskId);
      if (!runtimeTask) {
        return accumulator;
      }
      accumulator.push({
        taskId: task.taskId,
        state: runtimeTask.state,
        createdAt: runtimeTask.lastTransitionAt ?? run.createdAt,
        parentTaskId: task.parentTaskId,
        priority: 0
      });
      return accumulator;
    }, []);
}

export async function resolveWorkflowDispatchRoleSelection(
  input: WorkflowDispatchRoleSelectionInput
): Promise<WorkflowDispatchRoleSelectionResult | null> {
  const messages = sortMessagesByTime(
    await input.repositories.inbox.listInboxMessages(input.run.runId, input.role)
  ).filter((message) => !input.taskFilter || (extractTaskIdFromMessage(message) ?? "") === input.taskFilter);

  const roleTasks = buildWorkflowRoleTaskCandidates(input);
  const roleTaskById = new Map(roleTasks.map((task) => [task.taskId, task]));
  const runnableRoleTasks = roleTasks.filter(
    (task) =>
      task.state === "READY" ||
      (input.force &&
        input.taskFilter === task.taskId &&
        (task.state === "DISPATCHED" || task.state === "IN_PROGRESS" || task.state === "MAY_BE_DONE"))
  );

  const candidate = resolveOrchestratorDispatchCandidate({
    messages,
    runnableTasks: runnableRoleTasks,
    allTasks: roleTasks,
    force: input.force,
    resolveTaskById: (taskId) => roleTaskById.get(taskId) ?? null
  });
  if (!candidate) {
    return null;
  }

  const selectedMessageIds = candidate.selectedMessages.map((message) => message.envelope.message_id);
  const canSynthesizeTaskDispatch =
    candidate.taskId &&
    (candidate.selectedMessages.length === 0 ||
      candidate.selectedMessages.every((message) => isAutomaticTaskRedispatchSource(message, candidate.taskId!)));
  if (canSynthesizeTaskDispatch && candidate.taskId) {
    const syntheticMessage = buildSyntheticWorkflowTaskMessage(input, candidate.taskId, candidate.selectedMessages);
    const selectedRuntimeTask = input.runtimeTaskById.get(candidate.taskId) ?? null;
    if (!syntheticMessage || !selectedRuntimeTask) {
      return null;
    }
    return {
      taskId: candidate.taskId,
      dispatchKind: "task",
      message: syntheticMessage,
      selectedMessageIds,
      runtimeTask: selectedRuntimeTask
    };
  }

  const selectedRuntimeTask = candidate.taskId ? (input.runtimeTaskById.get(candidate.taskId) ?? null) : null;
  if (candidate.dispatchKind === "task" && !selectedRuntimeTask) {
    return null;
  }
  if (candidate.dispatchKind === "message" && !candidate.firstMessage) {
    return null;
  }

  return {
    taskId: candidate.taskId,
    dispatchKind: candidate.dispatchKind,
    message: candidate.firstMessage,
    selectedMessageIds,
    runtimeTask: selectedRuntimeTask
  };
}
