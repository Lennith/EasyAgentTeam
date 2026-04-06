import type { WorkflowRunRecord, WorkflowRunRuntimeState, WorkflowSessionRecord } from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import {
  checkAndFinalizeWorkflowRunByStableWindow,
  type WorkflowCompletionFinalizeContext
} from "./workflow-completion-finalize.js";
import {
  checkWorkflowTasksMayBeDone,
  type WorkflowCompletionMayBeDoneContext
} from "./workflow-completion-may-be-done.js";

export interface WorkflowCompletionServiceContext
  extends WorkflowCompletionMayBeDoneContext, WorkflowCompletionFinalizeContext {
  repositories: WorkflowRepositoryBundle;
}

export class WorkflowCompletionService {
  constructor(private readonly context: WorkflowCompletionServiceContext) {}

  async checkAndMarkMayBeDone(run: WorkflowRunRecord, runtime: WorkflowRunRuntimeState): Promise<void> {
    await checkWorkflowTasksMayBeDone(this.context, run, runtime);
  }

  async checkAndFinalizeRunByStableWindow(
    run: WorkflowRunRecord,
    runtime: WorkflowRunRuntimeState,
    sessions: WorkflowSessionRecord[]
  ): Promise<boolean> {
    return await checkAndFinalizeWorkflowRunByStableWindow(this.context, run, runtime, sessions);
  }
}
