import type { WorkflowRoleReminderState } from "../../domain/models.js";
import {
  getWorkflowRoleReminderState,
  updateWorkflowRoleReminderState
} from "../workflow-role-reminder-store.js";

export type WorkflowRoleReminderUpdates = Partial<Omit<WorkflowRoleReminderState, "role">>;

export interface WorkflowReminderRepository {
  getRoleReminderState(runId: string, role: string): Promise<WorkflowRoleReminderState | null>;
  updateRoleReminderState(
    runId: string,
    role: string,
    updates: WorkflowRoleReminderUpdates
  ): Promise<WorkflowRoleReminderState>;
}

class DefaultWorkflowReminderRepository implements WorkflowReminderRepository {
  constructor(private readonly dataRoot: string) {}

  getRoleReminderState(runId: string, role: string): Promise<WorkflowRoleReminderState | null> {
    return getWorkflowRoleReminderState(this.dataRoot, runId, role);
  }

  updateRoleReminderState(
    runId: string,
    role: string,
    updates: WorkflowRoleReminderUpdates
  ): Promise<WorkflowRoleReminderState> {
    return updateWorkflowRoleReminderState(this.dataRoot, runId, role, updates);
  }
}

export function createWorkflowReminderRepository(dataRoot: string): WorkflowReminderRepository {
  return new DefaultWorkflowReminderRepository(dataRoot);
}
