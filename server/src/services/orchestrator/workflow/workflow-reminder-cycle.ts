import type {
  WorkflowRoleReminderState,
  WorkflowRunRecord,
  WorkflowRunRuntimeState,
  WorkflowSessionRecord
} from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import { isRemindableTaskState } from "../../orchestrator-dispatch-core.js";
import { normalizeReminderMode } from "../shared/reminder-service.js";
import { resolveRoleRuntimeState } from "../shared/session-manager.js";
import { createOpaqueIdentifier, createTimestampedIdentifier } from "../shared/orchestrator-identifiers.js";
import {
  buildOrchestratorReminderMessage,
  buildOrchestratorReminderContent,
  buildOrchestratorReminderOpenTaskSummary,
  collectOrchestratorRoleSet,
  runOrchestratorReminderLoop,
  sortOrchestratorRoles
} from "../shared/index.js";

export interface WorkflowReminderContext {
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

interface WorkflowReminderOpenTask {
  taskId: string;
  resolvedTitle: string;
  parentTaskId?: string;
  ownerRole: string;
  dependencies?: string[];
  writeSet?: string[];
  acceptance?: string[];
  artifacts?: string[];
  state: string;
  summary?: string;
  createdAt: string;
}

async function triggerWorkflowRoleReminder(input: {
  context: WorkflowReminderContext;
  run: WorkflowRunRecord;
  role: string;
  session: WorkflowSessionRecord;
  reminderMode: ReturnType<typeof normalizeReminderMode>;
  reminderState: WorkflowRoleReminderState;
  roleOpenTasks: WorkflowReminderOpenTask[];
}): Promise<void> {
  const reminderMessageId = createTimestampedIdentifier("reminder-", 6);
  const reminderRequestId = createOpaqueIdentifier();
  const primaryTask = input.roleOpenTasks[0] ?? null;
  const primaryTaskId = primaryTask?.taskId ?? null;
  const openTaskSummary = buildOrchestratorReminderOpenTaskSummary(
    input.roleOpenTasks.map((task) => ({
      taskId: task.taskId,
      title: task.resolvedTitle
    }))
  );
  const content = buildOrchestratorReminderContent({
    openTaskCount: input.roleOpenTasks.length,
    openTaskTitlePreview: openTaskSummary.openTaskTitlePreview,
    instruction: "Please continue execution and submit TASK_REPORT for current work."
  });

  const message = buildOrchestratorReminderMessage({
    scopeKind: "workflow",
    scopeId: input.run.runId,
    role: input.role,
    reminderMode: input.reminderMode,
    reminderCount: input.reminderState.reminderCount,
    nextReminderAt: input.reminderState.nextReminderAt ?? null,
    openTasks: input.roleOpenTasks.map((task) => ({
      taskId: task.taskId,
      title: task.resolvedTitle
    })),
    content,
    requestId: reminderRequestId,
    parentRequestId: reminderRequestId,
    messageId: reminderMessageId,
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
  });
  await input.context.repositories.runInUnitOfWork({ run: input.run }, async () => {
    await input.context.repositories.inbox.appendInboxMessage(input.run.runId, input.role, message);
    await input.context.repositories.events.appendEvent(input.run.runId, {
      eventType: "ORCHESTRATOR_ROLE_REMINDER_TRIGGERED",
      source: "system",
      sessionId: input.session.sessionId,
      taskId: primaryTaskId ?? undefined,
      payload: {
        role: input.role,
        requestId: reminderRequestId,
        messageId: reminderMessageId,
        reminderMode: input.reminderMode,
        reminderCount: input.reminderState.reminderCount,
        nextReminderAt: input.reminderState.nextReminderAt ?? null,
        openTaskIds: openTaskSummary.openTaskIds,
        openTaskTitles: openTaskSummary.openTaskTitles
      }
    });
  });

  const redispatchResult = await input.context.dispatchRun(input.run.runId, {
    source: "loop",
    role: input.role,
    force: false,
    onlyIdle: false,
    maxDispatches: 1
  });
  const redispatchOutcome = redispatchResult.results[0]?.outcome ?? "no_message";
  await input.context.repositories.events.appendEvent(input.run.runId, {
    eventType: "ORCHESTRATOR_ROLE_REMINDER_REDISPATCH",
    source: "system",
    sessionId: input.session.sessionId,
    taskId: primaryTaskId ?? undefined,
    payload: {
      role: input.role,
      outcome: redispatchOutcome
    }
  });
}

export async function checkWorkflowRoleReminders(
  context: WorkflowReminderContext,
  run: WorkflowRunRecord,
  runtime: WorkflowRunRuntimeState,
  sessions: WorkflowSessionRecord[]
): Promise<void> {
  if (!context.autoReminderEnabled) {
    return;
  }
  const reminderMode = normalizeReminderMode(run.reminderMode);
  const nowMs = Date.now();
  const runtimeByTaskId = new Map(runtime.tasks.map((item) => [item.taskId, item]));
  const roleSet = collectOrchestratorRoleSet({
    sessionRoles: sessions.map((session) => session.role),
    taskOwnerRoles: run.tasks.map((task) => task.ownerRole)
  });

  await runOrchestratorReminderLoop<WorkflowRoleReminderState, WorkflowSessionRecord, WorkflowReminderOpenTask>({
    roles: sortOrchestratorRoles(roleSet),
    reminderMode,
    maxRetries: context.reminderMaxCount,
    nowMs,
    timing: {
      initialWaitMs: context.idleReminderMs,
      backoffMultiplier: context.reminderBackoffMultiplier,
      maxWaitMs: context.reminderMaxIntervalMs
    },
    describeRole: async (role) => {
      const idleSession = await context.resolveAuthoritativeSession(run.runId, role, sessions, run, "reminder");
      return {
        currentRoleState: resolveRoleRuntimeState(idleSession ? [idleSession] : []),
        idleSession,
        sessionIdleSince: idleSession ? (idleSession.lastDispatchedAt ?? idleSession.updatedAt) : undefined,
        openTasks: run.tasks
          .flatMap((task): WorkflowReminderOpenTask[] => {
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
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      };
    },
    getReminderState: async (role) => await context.repositories.reminders.getRoleReminderState(run.runId, role),
    initializeReminderState: async (role, initial) =>
      await context.repositories.reminders.updateRoleReminderState(run.runId, role, initial),
    updateReminderState: async (role, patch) =>
      await context.repositories.reminders.updateRoleReminderState(run.runId, role, patch),
    triggerReminder: async ({ role, reminderState, idleSession, openTasks }) =>
      await triggerWorkflowRoleReminder({
        context,
        run,
        role,
        session: idleSession,
        reminderMode,
        reminderState,
        roleOpenTasks: openTasks
      })
  });
}
