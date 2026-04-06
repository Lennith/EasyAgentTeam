import type { WorkflowRunRecord, WorkflowRunRuntimeState, WorkflowSessionRecord } from "../../../domain/models.js";
import { checkWorkflowRoleReminders, type WorkflowReminderContext } from "./workflow-reminder-cycle.js";

export type { WorkflowReminderContext } from "./workflow-reminder-cycle.js";

export class WorkflowReminderService {
  constructor(private readonly context: WorkflowReminderContext) {}

  async checkRoleReminders(
    run: WorkflowRunRecord,
    runtime: WorkflowRunRuntimeState,
    sessions: WorkflowSessionRecord[]
  ): Promise<void> {
    await checkWorkflowRoleReminders(this.context, run, runtime, sessions);
  }
}
