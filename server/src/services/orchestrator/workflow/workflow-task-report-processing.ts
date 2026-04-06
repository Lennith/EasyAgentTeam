import type {
  WorkflowRunRecord,
  WorkflowRunRuntimeSnapshot,
  WorkflowRunRuntimeState,
  WorkflowTaskActionResult
} from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import type { WorkflowTaskActionPipelineState } from "./workflow-task-action-types.js";
import {
  applyWorkflowTaskReportMutation,
  convergeWorkflowTaskReportRuntime,
  emitWorkflowTaskReportResult
} from "./workflow-task-report-application.js";
import {
  checkWorkflowTaskReportDependencyGate,
  type WorkflowTaskReportMutableState
} from "./workflow-task-report-guard.js";
import { runOrchestratorTaskActionPipeline } from "../shared/index.js";

export type WorkflowTaskReportPipelineState = WorkflowTaskActionPipelineState;

export interface ApplyWorkflowTaskReportActionInput {
  state: WorkflowTaskReportPipelineState;
  repositories: WorkflowRepositoryBundle;
  buildSnapshot(run: WorkflowRunRecord, runtime: WorkflowRunRuntimeState): WorkflowRunRuntimeSnapshot;
  createRuntimeError(
    message: string,
    code: string,
    status?: number,
    hint?: string,
    details?: Record<string, unknown>
  ): Error;
}

function createWorkflowTaskReportMutableState(state: WorkflowTaskReportPipelineState): WorkflowTaskReportMutableState {
  return {
    ...state,
    appliedTaskIds: [],
    rejectedResults: []
  };
}

export async function applyWorkflowTaskReportAction(
  input: ApplyWorkflowTaskReportActionInput
): Promise<Omit<WorkflowTaskActionResult, "requestId">> {
  return await runOrchestratorTaskActionPipeline(input.state, {
    parse: async (parsedState) => createWorkflowTaskReportMutableState(parsedState),
    authorize: async (authorizedState) => authorizedState,
    checkDependencyGate: async (gatedState) =>
      await checkWorkflowTaskReportDependencyGate(gatedState, input.createRuntimeError),
    apply: async (appliedState) => await applyWorkflowTaskReportMutation(appliedState, input.repositories),
    convergeRuntime: async (convergedState) =>
      await convergeWorkflowTaskReportRuntime(convergedState, input.repositories),
    emit: async (emittedState) =>
      await emitWorkflowTaskReportResult(emittedState, {
        repositories: input.repositories,
        buildSnapshot: input.buildSnapshot
      })
  });
}
