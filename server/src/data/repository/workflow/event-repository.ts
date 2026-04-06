import type { WorkflowRunEventRecord } from "../../../domain/models.js";
import { appendWorkflowRunEvent, listWorkflowRunEvents } from "./runtime-repository.js";

export type AppendWorkflowEventInput = Parameters<typeof appendWorkflowRunEvent>[2];

export interface WorkflowEventRepository {
  appendEvent(runId: string, input: AppendWorkflowEventInput): Promise<WorkflowRunEventRecord>;
  listEvents(runId: string, since?: string): Promise<WorkflowRunEventRecord[]>;
}

class DefaultWorkflowEventRepository implements WorkflowEventRepository {
  constructor(private readonly dataRoot: string) {}

  appendEvent(runId: string, input: AppendWorkflowEventInput): Promise<WorkflowRunEventRecord> {
    return appendWorkflowRunEvent(this.dataRoot, runId, input);
  }

  listEvents(runId: string, since?: string): Promise<WorkflowRunEventRecord[]> {
    return listWorkflowRunEvents(this.dataRoot, runId, since);
  }
}

export function createWorkflowEventRepository(dataRoot: string): WorkflowEventRepository {
  return new DefaultWorkflowEventRepository(dataRoot);
}
