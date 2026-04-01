import type {
  WorkflowManagerToAgentMessage,
  WorkflowRunRecord,
  WorkflowTaskRuntimeRecord,
  WorkflowTaskState
} from "../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../data/repository/workflow-repository-bundle.js";
import { extractTaskIdFromMessage, sortMessagesByTime } from "../orchestrator-dispatch-core.js";
import { resolveOrchestratorDispatchCandidate } from "./shared/dispatch-selection-candidate.js";

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
  runtimeTask: WorkflowTaskRuntimeRecord | null;
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
    runtimeTask: selectedRuntimeTask
  };
}
