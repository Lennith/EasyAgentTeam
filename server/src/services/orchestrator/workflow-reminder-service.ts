import type {
  WorkflowManagerToAgentMessage,
  WorkflowRunRecord,
  WorkflowRunRuntimeState,
  WorkflowSessionRecord
} from "../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../data/repository/workflow-repository-bundle.js";
import { isRemindableTaskState } from "../orchestrator-dispatch-core.js";
import { buildReminderMessageBody } from "../reminder-message-builder.js";
import { normalizeReminderMode } from "./reminder-service.js";
import { resolveRoleRuntimeState } from "./session-manager.js";
import { createOpaqueIdentifier, createTimestampedIdentifier } from "./shared/orchestrator-identifiers.js";
import {
  buildOrchestratorReminderRoleStatePatch,
  buildOrchestratorReminderSchedulePatch,
  buildOrchestratorReminderTriggeredPatch,
  collectOrchestratorRoleSet,
  evaluateOrchestratorReminderEligibility,
  sortOrchestratorRoles
} from "./shared/index.js";

interface WorkflowReminderContext {
  repositories: WorkflowRepositoryBundle;
  idleReminderMs: number;
  reminderBackoffMultiplier: number;
  reminderMaxIntervalMs: number;
  reminderMaxCount: number;
  autoReminderEnabled: boolean;
  resolveAuthoritativeSession(
    runId: string,
    role: string,
    sessions: WorkflowSessionRecord[],
    runRecord?: WorkflowRunRecord,
    reason?: string
  ): Promise<WorkflowSessionRecord | null>;
  dispatchRun(
    runId: string,
    input: {
      role?: string;
      taskId?: string;
      force?: boolean;
      onlyIdle?: boolean;
      maxDispatches?: number;
      source?: "manual" | "loop";
    }
  ): Promise<{ results: Array<{ outcome: string }> }>;
}

export class WorkflowReminderService {
  constructor(private readonly context: WorkflowReminderContext) {}

  async checkRoleReminders(
    run: WorkflowRunRecord,
    runtime: WorkflowRunRuntimeState,
    sessions: WorkflowSessionRecord[]
  ): Promise<void> {
    if (!this.context.autoReminderEnabled) {
      return;
    }
    const nowMs = Date.now();
    const reminderMode = normalizeReminderMode(run.reminderMode);
    const maxRetries = this.context.reminderMaxCount;
    const backoffMultiplier = this.context.reminderBackoffMultiplier;
    const maxIntervalMs = this.context.reminderMaxIntervalMs;
    const runtimeByTaskId = new Map(runtime.tasks.map((item) => [item.taskId, item]));
    const roleSet = collectOrchestratorRoleSet({
      sessionRoles: sessions.map((session) => session.role),
      taskOwnerRoles: run.tasks.map((task) => task.ownerRole)
    });

    for (const role of sortOrchestratorRoles(roleSet)) {
      const session = await this.context.resolveAuthoritativeSession(run.runId, role, sessions, run, "reminder");
      const currentRoleState = resolveRoleRuntimeState(session ? [session] : []);
      const roleOpenTasks = run.tasks
        .flatMap((task) => {
          if (task.ownerRole !== role) {
            return [];
          }
          const runtimeTask = runtimeByTaskId.get(task.taskId);
          if (!runtimeTask || !isRemindableTaskState(runtimeTask.state)) {
            return [];
          }
          return [
            {
              taskId: task.taskId,
              resolvedTitle: task.resolvedTitle,
              parentTaskId: task.parentTaskId,
              ownerRole: task.ownerRole,
              dependencies: task.dependencies,
              writeSet: task.writeSet,
              acceptance: task.acceptance,
              artifacts: task.artifacts,
              state: runtimeTask.state,
              summary: runtimeTask.lastSummary,
              createdAt: runtimeTask.lastTransitionAt ?? run.createdAt
            }
          ];
        })
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const hasOpenTask = roleOpenTasks.length > 0;
      const sessionIdleSince = session ? (session.lastDispatchedAt ?? session.updatedAt) : undefined;

      let reminderState = await this.context.repositories.reminders.getRoleReminderState(run.runId, role);
      if (!reminderState) {
        reminderState = await this.context.repositories.reminders.updateRoleReminderState(run.runId, role, {
          idleSince: sessionIdleSince,
          reminderCount: 0,
          lastRoleState: currentRoleState
        });
      }

      reminderState = await this.context.repositories.reminders.updateRoleReminderState(run.runId, role, {
        ...buildOrchestratorReminderRoleStatePatch({
          previousRoleState: reminderState.lastRoleState ?? "INACTIVE",
          currentRoleState,
          reminderMode,
          reminderCount: reminderState.reminderCount,
          nowMs,
          idleSince: sessionIdleSince,
          timing: {
            initialWaitMs: this.context.idleReminderMs,
            backoffMultiplier,
            maxWaitMs: maxIntervalMs
          }
        })
      });

      const eligibility = evaluateOrchestratorReminderEligibility({
        currentRoleState,
        hasIdleSession: Boolean(session),
        hasOpenTask,
        reminderCount: reminderState.reminderCount,
        maxRetries,
        idleSince: reminderState.idleSince,
        nextReminderAt: reminderState.nextReminderAt,
        nowMs
      });

      if (eligibility.reason === "skip_no_open_task") {
        await this.context.repositories.reminders.updateRoleReminderState(run.runId, role, {
          reminderCount: 0,
          nextReminderAt: undefined,
          lastRoleState: "IDLE"
        });
        continue;
      }
      if (eligibility.reason === "schedule_missing_next_reminder") {
        await this.context.repositories.reminders.updateRoleReminderState(run.runId, role, {
          ...buildOrchestratorReminderSchedulePatch({
            reminderMode,
            reminderCount: reminderState.reminderCount,
            nowMs,
            timing: {
              initialWaitMs: this.context.idleReminderMs,
              backoffMultiplier,
              maxWaitMs: maxIntervalMs
            }
          })
        });
        continue;
      }
      if (!eligibility.eligible || !session) {
        continue;
      }

      reminderState = await this.context.repositories.reminders.updateRoleReminderState(run.runId, role, {
        ...buildOrchestratorReminderTriggeredPatch({
          reminderMode,
          reminderCount: reminderState.reminderCount,
          nowMs,
          timing: {
            initialWaitMs: this.context.idleReminderMs,
            backoffMultiplier,
            maxWaitMs: maxIntervalMs
          }
        })
      });

      const reminderMessageId = createTimestampedIdentifier("reminder-", 6);
      const reminderRequestId = createOpaqueIdentifier();
      const primaryTask = roleOpenTasks[0] ?? null;
      const primaryTaskId = primaryTask?.taskId ?? null;
      const openTaskTitlePreview = roleOpenTasks
        .slice(0, 3)
        .map((task) => `${task.taskId}: ${task.resolvedTitle}`)
        .join("; ");
      const content =
        `Reminder: you have ${roleOpenTasks.length} open task(s) without recent progress. ` +
        (openTaskTitlePreview.length > 0 ? `Open tasks: ${openTaskTitlePreview}. ` : "") +
        "Please continue execution and submit TASK_REPORT for current work.";

      const message: WorkflowManagerToAgentMessage = {
        envelope: {
          message_id: reminderMessageId,
          run_id: run.runId,
          timestamp: new Date().toISOString(),
          sender: { type: "system", role: "manager", session_id: "manager-system" },
          via: { type: "manager" },
          intent: "MANAGER_MESSAGE",
          priority: "normal",
          correlation: {
            request_id: reminderRequestId,
            parent_request_id: reminderRequestId,
            task_id: primaryTaskId ?? undefined
          },
          accountability: {
            owner_role: role,
            report_to: { role: "manager", session_id: "manager-system" },
            expect: "TASK_REPORT"
          },
          dispatch_policy: "fixed_session"
        },
        body: buildReminderMessageBody({
          role,
          reminderMode,
          reminderCount: reminderState.reminderCount,
          nextReminderAt: reminderState.nextReminderAt ?? null,
          openTasks: roleOpenTasks.map((task) => ({
            taskId: task.taskId,
            title: task.resolvedTitle
          })),
          content,
          primaryTaskId,
          primarySummary: primaryTask?.summary ?? "",
          primaryTask:
            primaryTask === null
              ? null
              : {
                  task_id: primaryTask.taskId,
                  state: primaryTask.state,
                  owner_role: primaryTask.ownerRole,
                  parent_task_id: primaryTask.parentTaskId ?? null,
                  write_set: primaryTask.writeSet ?? [],
                  dependencies: primaryTask.dependencies ?? [],
                  acceptance: primaryTask.acceptance ?? [],
                  artifacts: primaryTask.artifacts ?? []
                }
        })
      };
      await this.context.repositories.runInUnitOfWork({ run }, async () => {
        await this.context.repositories.inbox.appendInboxMessage(run.runId, role, message);
        await this.context.repositories.events.appendEvent(run.runId, {
          eventType: "ORCHESTRATOR_ROLE_REMINDER_TRIGGERED",
          source: "system",
          sessionId: session.sessionId,
          taskId: primaryTaskId ?? undefined,
          payload: {
            role,
            requestId: reminderRequestId,
            messageId: reminderMessageId,
            reminderMode,
            reminderCount: reminderState.reminderCount,
            nextReminderAt: reminderState.nextReminderAt ?? null,
            openTaskIds: roleOpenTasks.map((task) => task.taskId),
            openTaskTitles: roleOpenTasks.map((task) => ({
              task_id: task.taskId,
              title: task.resolvedTitle
            }))
          }
        });
      });
      const redispatchResult = await this.context.dispatchRun(run.runId, {
        source: "loop",
        role,
        force: false,
        onlyIdle: false,
        maxDispatches: 1
      });
      const redispatchOutcome = redispatchResult.results[0]?.outcome ?? "no_message";
      await this.context.repositories.events.appendEvent(run.runId, {
        eventType: "ORCHESTRATOR_ROLE_REMINDER_REDISPATCH",
        source: "system",
        sessionId: session.sessionId,
        taskId: primaryTaskId ?? undefined,
        payload: {
          role,
          outcome: redispatchOutcome
        }
      });
    }
  }
}
