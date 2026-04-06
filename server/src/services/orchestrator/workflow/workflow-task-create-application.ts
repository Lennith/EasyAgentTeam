import type {
  WorkflowRunRecord,
  WorkflowRunRuntimeSnapshot,
  WorkflowRunRuntimeState,
  WorkflowTaskActionResult
} from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import { convergeWorkflowRuntime } from "../shared/runtime/workflow-runtime-kernel.js";
import type { WorkflowTaskCreateMutableState } from "./workflow-task-create-guard.js";

export type WorkflowTaskCreateConvergedState = WorkflowTaskCreateMutableState & {
  nextTasks: WorkflowRunRecord["tasks"];
  nextRuntime: WorkflowRunRuntimeState;
  updated: WorkflowRunRecord;
};

interface WorkflowTaskCreateResultContext {
  buildSnapshot(run: WorkflowRunRecord, runtime: WorkflowRunRuntimeState): WorkflowRunRuntimeSnapshot;
}

function normalizeWorkflowTaskCreateList(values: string[] | undefined): string[] {
  return (values ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
}

export async function applyWorkflowTaskCreateMutation<TState extends WorkflowTaskCreateMutableState>(
  state: TState
): Promise<TState & { nextTasks: WorkflowRunRecord["tasks"] }> {
  const nextTasks: WorkflowRunRecord["tasks"] = [
    ...state.currentRun.tasks,
    {
      taskId: state.taskId,
      title: state.taskTitle,
      resolvedTitle: state.taskTitle,
      ownerRole: state.ownerRole,
      parentTaskId: state.parentTaskId,
      dependencies: state.dependencies,
      acceptance: normalizeWorkflowTaskCreateList(state.task.acceptance),
      artifacts: normalizeWorkflowTaskCreateList(state.task.artifacts),
      creatorRole: state.input.fromAgent?.trim() || undefined,
      creatorSessionId: state.input.fromSessionId?.trim() || undefined
    }
  ];
  state.appliedTaskIds.push(state.taskId);
  return {
    ...state,
    nextTasks
  };
}

export async function convergeWorkflowTaskCreateRuntime<
  TState extends WorkflowTaskCreateMutableState & {
    nextTasks: WorkflowRunRecord["tasks"];
  }
>(
  state: TState,
  repositories: Pick<WorkflowRepositoryBundle, "workflowRuns">
): Promise<WorkflowTaskCreateConvergedState> {
  const runWithNewTasks: WorkflowRunRecord = {
    ...state.currentRun,
    tasks: state.nextTasks
  };
  const nextRuntime = convergeWorkflowRuntime(runWithNewTasks, state.currentRuntime).runtime;
  await repositories.workflowRuns.writeRuntime(state.runId, nextRuntime);
  const updated = await repositories.workflowRuns.patchRun(state.runId, {
    runtime: nextRuntime,
    tasks: state.nextTasks
  });
  return {
    ...state,
    nextRuntime,
    updated
  };
}

export async function emitWorkflowTaskCreateResult(
  state: WorkflowTaskCreateConvergedState,
  context: WorkflowTaskCreateResultContext
): Promise<Omit<WorkflowTaskActionResult, "requestId">> {
  return {
    success: true,
    actionType: state.actionType,
    createdTaskId: state.taskId,
    partialApplied: false,
    appliedTaskIds: state.appliedTaskIds,
    rejectedResults: state.rejectedResults,
    snapshot: context.buildSnapshot(state.updated, state.nextRuntime)
  };
}
