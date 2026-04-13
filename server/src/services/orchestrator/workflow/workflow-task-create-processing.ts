import type {
  WorkflowRunRecord,
  WorkflowRunRuntimeSnapshot,
  WorkflowRunRuntimeState,
  WorkflowTaskActionResult
} from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import {
  applyWorkflowTaskCreateMutation,
  convergeWorkflowTaskCreateRuntime,
  emitWorkflowTaskCreateResult
} from "./workflow-task-create-application.js";
import {
  authorizeWorkflowTaskCreateState,
  checkWorkflowTaskCreateDependencyGate,
  parseWorkflowTaskCreateState
} from "./workflow-task-create-guard.js";
import { runOrchestratorTaskActionPipeline } from "../shared/index.js";
import type { WorkflowTaskActionPipelineState } from "./workflow-task-action-types.js";

export interface ApplyWorkflowTaskCreateActionInput {
  state: WorkflowTaskActionPipelineState;
  repositories: WorkflowRepositoryBundle;
  buildSnapshot(run: WorkflowRunRecord, runtime: WorkflowRunRuntimeState): WorkflowRunRuntimeSnapshot;
  createRuntimeError(
    message: string,
    code: string,
    status?: number,
    nextAction?: string,
    details?: Record<string, unknown>
  ): Error;
}

export async function applyWorkflowTaskCreateAction(
  input: ApplyWorkflowTaskCreateActionInput
): Promise<Omit<WorkflowTaskActionResult, "requestId">> {
  return await runOrchestratorTaskActionPipeline(input.state, {
    parse: async (parsedState) => await parseWorkflowTaskCreateState(parsedState, input.createRuntimeError),
    authorize: async (authorizedState) =>
      await authorizeWorkflowTaskCreateState(authorizedState, input.repositories, input.createRuntimeError),
    checkDependencyGate: async (gatedState) =>
      await checkWorkflowTaskCreateDependencyGate(gatedState, input.createRuntimeError),
    apply: async (appliedState) => await applyWorkflowTaskCreateMutation(appliedState),
    convergeRuntime: async (convergedState) =>
      await convergeWorkflowTaskCreateRuntime(convergedState, input.repositories),
    emit: async (emittedState) =>
      await emitWorkflowTaskCreateResult(emittedState, {
        buildSnapshot: input.buildSnapshot
      })
  });
}
