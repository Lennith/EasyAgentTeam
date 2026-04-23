import type { WorkflowRunEventRecord } from "../../../domain/models.js";
import {
  appendWorkflowRunEvent,
  getWorkflowRecoveryEventIndex,
  listWorkflowRunEvents
} from "./runtime-repository.js";
import type { RecoveryEventIndexState } from "../../../services/runtime-recovery-event-index.js";

export type AppendWorkflowEventInput = Parameters<typeof appendWorkflowRunEvent>[2];

export interface WorkflowEventRepository {
  appendEvent(runId: string, input: AppendWorkflowEventInput): Promise<WorkflowRunEventRecord>;
  listEvents(runId: string, since?: string): Promise<WorkflowRunEventRecord[]>;
  getRecoveryEventIndex(runId: string): Promise<RecoveryEventIndexState>;
}

class DefaultWorkflowEventRepository implements WorkflowEventRepository {
  constructor(private readonly dataRoot: string) {}

  appendEvent(runId: string, input: AppendWorkflowEventInput): Promise<WorkflowRunEventRecord> {
    return appendWorkflowRunEvent(this.dataRoot, runId, input);
  }

  listEvents(runId: string, since?: string): Promise<WorkflowRunEventRecord[]> {
    return listWorkflowRunEvents(this.dataRoot, runId, since);
  }

  getRecoveryEventIndex(runId: string): Promise<RecoveryEventIndexState> {
    return getWorkflowRecoveryEventIndex(this.dataRoot, runId);
  }
}

export function createWorkflowEventRepository(dataRoot: string): WorkflowEventRepository {
  return new DefaultWorkflowEventRepository(dataRoot);
}
