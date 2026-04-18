import type { WorkflowTaskActionResult } from "../../../domain/models.js";
import type { WorkflowTaskActionPipelineState } from "./workflow-task-action-types.js";
import { resolveWorkflowUnreadyDependencyTaskIds } from "../shared/runtime/workflow-runtime-kernel.js";
import {
  buildOrchestratorDependencyNotReadyNextAction,
  isOrchestratorTaskReportableState,
  parseOrchestratorTaskReportOutcome,
  requiresOrchestratorReadyDependencies
} from "../shared/index.js";

export type WorkflowTaskReportMutableState = WorkflowTaskActionPipelineState & {
  appliedTaskIds: string[];
  rejectedResults: WorkflowTaskActionResult["rejectedResults"];
};

export interface WorkflowTaskReportErrorFactory {
  (message: string, code: string, status?: number, nextAction?: string, details?: Record<string, unknown>): Error;
}

export async function checkWorkflowTaskReportDependencyGate<TState extends WorkflowTaskReportMutableState>(
  state: TState,
  createRuntimeError: WorkflowTaskReportErrorFactory
): Promise<TState> {
  const predictedStateByTaskId = new Map(state.currentRuntime.tasks.map((item) => [item.taskId, item.state]));
  for (const result of state.input.results ?? []) {
    const taskDef = state.runTaskById.get(result.taskId);
    const runtimeTask = state.byTask.get(result.taskId);
    if (!taskDef || !runtimeTask) {
      continue;
    }
    const target = parseOrchestratorTaskReportOutcome(result.outcome);
    if (!target) {
      continue;
    }
    if (state.fromAgent !== "manager" && taskDef.ownerRole !== state.fromAgent) {
      continue;
    }
    const currentState = predictedStateByTaskId.get(result.taskId) ?? runtimeTask.state;
    if (!isOrchestratorTaskReportableState(currentState)) {
      continue;
    }
    if (!requiresOrchestratorReadyDependencies(target)) {
      predictedStateByTaskId.set(result.taskId, target);
      continue;
    }
    const unresolvedDependencyTaskIds = resolveWorkflowUnreadyDependencyTaskIds(
      taskDef,
      state.byTask,
      predictedStateByTaskId
    );
    if (unresolvedDependencyTaskIds.length > 0) {
      throw createRuntimeError(
        `task '${result.taskId}' cannot transition to '${target}' before dependencies are ready: ${unresolvedDependencyTaskIds.join(", ")}`,
        "TASK_DEPENDENCY_NOT_READY",
        409,
        buildOrchestratorDependencyNotReadyNextAction(result.taskId, unresolvedDependencyTaskIds),
        {
          task_id: result.taskId,
          dependency_task_ids: unresolvedDependencyTaskIds,
          current_state: currentState,
          reported_target_state: target,
          focus_task_id: state.input.taskId ?? null
        }
      );
    }
    predictedStateByTaskId.set(result.taskId, target);
  }
  return state;
}
