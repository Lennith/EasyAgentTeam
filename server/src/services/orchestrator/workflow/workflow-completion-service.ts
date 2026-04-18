import type { WorkflowRunRecord, WorkflowRunRuntimeState, WorkflowSessionRecord } from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import {
  checkAndFinalizeWorkflowRunByStableWindow,
  type WorkflowCompletionFinalizeContext
} from "./workflow-completion-finalize.js";

export interface WorkflowCompletionServiceContext extends WorkflowCompletionFinalizeContext {
  repositories: WorkflowRepositoryBundle;
}

export class WorkflowCompletionService {
  constructor(private readonly context: WorkflowCompletionServiceContext) {}

  async checkAndFinalizeRunByStableWindow(
    run: WorkflowRunRecord,
    runtime: WorkflowRunRuntimeState,
    sessions: WorkflowSessionRecord[]
  ): Promise<boolean> {
    return await checkAndFinalizeWorkflowRunByStableWindow(this.context, run, runtime, sessions);
  }
}
