import type { WorkflowManagerToAgentMessage } from "../../domain/models.js";
import {
  appendWorkflowInboxMessage,
  listWorkflowInboxMessages,
  removeWorkflowInboxMessages
} from "../workflow-run-store.js";

export interface WorkflowInboxRepository {
  appendInboxMessage(runId: string, targetRole: string, message: WorkflowManagerToAgentMessage): Promise<string>;
  listInboxMessages(runId: string, targetRole: string, limit?: number): Promise<WorkflowManagerToAgentMessage[]>;
  removeInboxMessages(runId: string, targetRole: string, messageIds: string[]): Promise<number>;
}

class DefaultWorkflowInboxRepository implements WorkflowInboxRepository {
  constructor(private readonly dataRoot: string) {}

  appendInboxMessage(runId: string, targetRole: string, message: WorkflowManagerToAgentMessage): Promise<string> {
    return appendWorkflowInboxMessage(this.dataRoot, runId, targetRole, message);
  }

  listInboxMessages(runId: string, targetRole: string, limit?: number): Promise<WorkflowManagerToAgentMessage[]> {
    return listWorkflowInboxMessages(this.dataRoot, runId, targetRole, limit);
  }

  removeInboxMessages(runId: string, targetRole: string, messageIds: string[]): Promise<number> {
    return removeWorkflowInboxMessages(this.dataRoot, runId, targetRole, messageIds);
  }
}

export function createWorkflowInboxRepository(dataRoot: string): WorkflowInboxRepository {
  return new DefaultWorkflowInboxRepository(dataRoot);
}
