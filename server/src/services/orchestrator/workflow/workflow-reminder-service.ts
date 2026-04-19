import type { WorkflowRunRecord, WorkflowRunRuntimeState, WorkflowSessionRecord } from "../../../domain/models.js";
import { calculateNextReminderTimeByMode } from "../project/project-reminder-policy.js";
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

  async resetRoleReminderOnManualAction(
    runId: string,
    role: string,
    reason: "session_created" | "session_dismissed" | "session_repaired"
  ): Promise<void> {
    const normalizedRole = role.trim();
    if (!normalizedRole) {
      return;
    }
    const scope = await this.context.repositories.resolveScope(runId);
    const { run } = scope;
    const existing = await this.context.repositories.reminders.getRoleReminderState(run.runId, normalizedRole);
    const previousReminderCount = existing?.reminderCount ?? 0;
    const reminderMode = run.reminderMode ?? "backoff";
    const delayedReminderAt = calculateNextReminderTimeByMode(reminderMode, 0, Date.now(), {
      initialWaitMs: this.context.idleReminderMs ?? 60000,
      backoffMultiplier: this.context.reminderBackoffMultiplier ?? 2,
      maxWaitMs: this.context.reminderMaxIntervalMs ?? 1800000
    });
    await this.context.repositories.runInUnitOfWork(scope, async () => {
      await this.context.repositories.reminders.updateRoleReminderState(run.runId, normalizedRole, {
        reminderCount: 0,
        idleSince: undefined,
        nextReminderAt: delayedReminderAt,
        lastRoleState: "INACTIVE"
      });
      await this.context.repositories.events.appendEvent(run.runId, {
        eventType: "ORCHESTRATOR_ROLE_REMINDER_RESET",
        source: "manager",
        payload: {
          role: normalizedRole,
          reason,
          previous_reminder_count: previousReminderCount,
          next_reminder_at: delayedReminderAt
        }
      });
    });
  }
}
