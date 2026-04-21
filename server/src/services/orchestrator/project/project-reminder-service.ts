import { randomUUID } from "node:crypto";
import type { ProjectPaths, ProjectRecord } from "../../../domain/models.js";
import { resolveActiveSessionForRole } from "../../session-lifecycle-authority.js";
import { isRemindableTaskState } from "../../orchestrator-dispatch-core.js";
import { resolveLatestIdleSession, resolveRoleRuntimeState } from "../shared/session-manager.js";
import { calculateNextReminderTimeByMode } from "./project-reminder-policy.js";
import {
  buildOrchestratorReminderMessage,
  buildOrchestratorReminderContent,
  buildOrchestratorReminderOpenTaskSummary,
  hasOrchestratorUnresolvedDescendants,
  collectOrchestratorRoleSet,
  runOrchestratorReminderLoop
} from "../shared/index.js";
import type { ProjectReminderContext, ReminderResetReason } from "./project-orchestrator-types.js";

function hasReminderEligibleSubtree(taskId: string, allTasks: WorkflowLikeTask[]): boolean {
  return !hasOrchestratorUnresolvedDescendants(taskId, allTasks);
}

type WorkflowLikeTask = {
  taskId: string;
  parentTaskId: string;
  state: string;
  ownerRole: string;
  ownerSession?: string | null;
  closeReportId?: string | null;
  lastSummary?: string | null;
};

export class ProjectReminderService {
  constructor(private readonly context: ProjectReminderContext) {}

  async resetRoleReminderOnManualAction(projectId: string, role: string, reason: ReminderResetReason): Promise<void> {
    const normalizedRole = role.trim();
    if (!normalizedRole) {
      return;
    }
    const scope = await this.context.repositories.resolveScope(projectId);
    const { project, paths } = scope;
    const existing = await this.context.repositories.projectRuntime.getRoleReminderState(
      paths,
      project.projectId,
      normalizedRole
    );
    const previousReminderCount = existing?.reminderCount ?? 0;
    const reminderMode = project.reminderMode ?? "backoff";
    const delayedReminderAt = calculateNextReminderTimeByMode(reminderMode, 0, Date.now(), {
      initialWaitMs: this.context.idleTimeoutMs,
      backoffMultiplier: this.context.reminderBackoffMultiplier ?? 2,
      maxWaitMs: this.context.reminderMaxIntervalMs ?? 1800000
    });
    await this.context.repositories.runInUnitOfWork(scope, async () => {
      await this.context.repositories.projectRuntime.updateRoleReminderState(paths, project.projectId, normalizedRole, {
        reminderCount: 0,
        idleSince: undefined,
        nextReminderAt: delayedReminderAt,
        lastRoleState: "INACTIVE"
      });
      await this.context.repositories.events.appendEvent(paths, {
        projectId: project.projectId,
        eventType: "ORCHESTRATOR_ROLE_REMINDER_RESET",
        source: "manager",
        payload: {
          role: normalizedRole,
          reason,
          previousReminderCount,
          nextReminderAt: delayedReminderAt
        }
      });
    });
  }

  async checkIdleRoles(project: ProjectRecord, paths: ProjectPaths): Promise<void> {
    if (project.autoReminderEnabled === false || this.context.autoReminderEnabled === false) {
      return;
    }

    const sessions = await this.context.repositories.sessions.listSessions(paths, project.projectId);
    const allTasks = await this.context.repositories.taskboard.listTasks(paths, project.projectId);
    const nowMs = Date.now();
    const subtreeTasks: WorkflowLikeTask[] = allTasks.map((task) => ({
      taskId: task.taskId,
      parentTaskId: task.parentTaskId,
      state: task.state,
      ownerRole: task.ownerRole,
      ownerSession: task.ownerSession ?? null,
      closeReportId: task.closeReportId ?? null,
      lastSummary: task.lastSummary ?? null
    }));

    const reminderMode = project.reminderMode ?? "backoff";
    const roleSet = collectOrchestratorRoleSet({
      sessionRoles: sessions.map((session) => session.role),
      taskOwnerRoles: allTasks.map((task) => task.ownerRole)
    });

    await runOrchestratorReminderLoop({
      roles: roleSet,
      reminderMode,
      maxRetries: this.context.reminderMaxCount ?? 5,
      nowMs,
      timing: {
        initialWaitMs: this.context.idleTimeoutMs ?? 60000,
        backoffMultiplier: this.context.reminderBackoffMultiplier ?? 2,
        maxWaitMs: this.context.reminderMaxIntervalMs ?? 1800000
      },
      describeRole: async (role) => {
        const activeSession = await resolveActiveSessionForRole({
          dataRoot: this.context.dataRoot,
          project,
          paths,
          role,
          reason: "check_idle_roles"
        });
        const roleSessions = activeSession ? [activeSession] : [];
        const idleSession = resolveLatestIdleSession(roleSessions);
        return {
          currentRoleState: resolveRoleRuntimeState(roleSessions),
          idleSession: idleSession ?? null,
          sessionIdleSince: idleSession
            ? (idleSession.idleSince ?? idleSession.lastDispatchedAt ?? idleSession.updatedAt)
            : undefined,
          openTasks: allTasks
            .filter((task) => task.ownerRole === role && isRemindableTaskState(task.state))
            .filter((task) => hasReminderEligibleSubtree(task.taskId, subtreeTasks))
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        };
      },
      getReminderState: async (role) =>
        await this.context.repositories.projectRuntime.getRoleReminderState(paths, project.projectId, role),
      initializeReminderState: async (role, initial) =>
        await this.context.repositories.projectRuntime.updateRoleReminderState(paths, project.projectId, role, initial),
      updateReminderState: async (role, patch) =>
        await this.context.repositories.projectRuntime.updateRoleReminderState(paths, project.projectId, role, patch),
      triggerReminder: async ({ role, reminderState, idleSession, openTasks }) => {
        const reminderRequestId = randomUUID();
        const reminderMessageId = randomUUID();
        const primaryTask = openTasks[0] ?? null;
        const primaryTaskId = primaryTask?.taskId ?? null;
        const openTaskSummary = buildOrchestratorReminderOpenTaskSummary(
          openTasks.map((task) => ({
            taskId: task.taskId,
            title: task.title
          }))
        );
        const reminderMessage = buildOrchestratorReminderMessage({
          scopeKind: "project",
          scopeId: project.projectId,
          role,
          reminderMode,
          reminderCount: reminderState.reminderCount,
          nextReminderAt: null,
          openTasks: openTasks.map((task) => ({
            taskId: task.taskId,
            title: task.title
          })),
          content: buildOrchestratorReminderContent({
            openTaskCount: openTasks.length,
            openTaskTitlePreview: openTaskSummary.openTaskTitlePreview,
            instruction:
              "Please update progress and submit TASK_REPORT with results[].outcome in IN_PROGRESS|BLOCKED_DEP|DONE|CANCELED for current work."
          }),
          requestId: reminderRequestId,
          messageId: reminderMessageId,
          primaryTaskId,
          primarySummary: primaryTask?.lastSummary ?? "",
          primaryTask:
            primaryTask === null
              ? null
              : {
                  task_id: primaryTask.taskId,
                  task_kind: primaryTask.taskKind,
                  parent_task_id: primaryTask.parentTaskId,
                  root_task_id: primaryTask.rootTaskId,
                  state: primaryTask.state,
                  owner_role: primaryTask.ownerRole,
                  owner_session: primaryTask.ownerSession ?? null,
                  priority: primaryTask.priority ?? 0,
                  write_set: primaryTask.writeSet,
                  dependencies: primaryTask.dependencies,
                  acceptance: primaryTask.acceptance,
                  artifacts: primaryTask.artifacts
                }
        });

        await this.context.repositories.runInUnitOfWork({ project, paths }, async () => {
          await this.context.repositories.inbox.appendInboxMessage(paths, role, reminderMessage);
          await this.context.repositories.events.appendEvent(paths, {
            projectId: project.projectId,
            eventType: "ORCHESTRATOR_ROLE_REMINDER_TRIGGERED",
            source: "manager",
            sessionId: idleSession.sessionId,
            taskId: primaryTaskId,
            payload: {
              requestId: reminderRequestId,
              messageId: reminderMessageId,
              role,
              reminderMode,
              reminderCount: reminderState.reminderCount,
              nextReminderAt: reminderState.nextReminderAt ?? null,
              openTaskIds: openTaskSummary.openTaskIds,
              openTaskTitles: openTaskSummary.openTaskTitles
            }
          });
        });

        const redispatchResult = await this.context.dispatchProject(project.projectId, {
          mode: "loop",
          sessionId: idleSession.sessionId,
          taskId: primaryTaskId,
          force: false,
          onlyIdle: true,
          maxDispatches: 1
        });
        const redispatchOutcome = redispatchResult.results[0]?.outcome ?? "no_message";
        await this.context.repositories.events.appendEvent(paths, {
          projectId: project.projectId,
          eventType: "ORCHESTRATOR_ROLE_REMINDER_REDISPATCH",
          source: "manager",
          sessionId: idleSession.sessionId,
          taskId: primaryTaskId,
          payload: {
            role,
            outcome: redispatchOutcome
          }
        });
      }
    });
  }
}
