import type { WorkflowRunRecord, WorkflowRunRuntimeState, WorkflowTaskActionRequest } from "../../domain/models.js";

export interface WorkflowTaskActionPipelineState {
  runId: string;
  input: WorkflowTaskActionRequest;
  fromAgent: string;
  actionType: WorkflowTaskActionRequest["actionType"];
  currentRun: WorkflowRunRecord;
  currentRuntime: WorkflowRunRuntimeState;
  byTask: Map<string, WorkflowRunRuntimeState["tasks"][number]>;
  runTaskById: Map<string, WorkflowRunRecord["tasks"][number]>;
}
