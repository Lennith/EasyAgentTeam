import { randomUUID } from "node:crypto";
import type { ProjectPaths, ProjectRecord } from "../../domain/models.js";
import { resolveActiveSessionForRole } from "../session-lifecycle-authority.js";
import { isRemindableTaskState } from "../orchestrator-dispatch-core.js";
import { resolveLatestIdleSession, resolveRoleRuntimeState } from "./session-manager.js";
import { calculateNextReminderTimeByMode } from "./project-reminder-policy.js";
import {
  buildOrchestratorReminderMessage,
  buildOrchestratorReminderContent,
  buildOrchestratorReminderOpenTaskSummary,
  buildOrchestratorReminderRoleStatePatch,
  buildOrchestratorReminderSchedulePatch,
  buildOrchestratorReminderTriggeredPatch,
  collectOrchestratorRoleSet,
  evaluateOrchestratorReminderEligibility
} from "./shared/index.js";
import type { ProjectReminderContext, ReminderResetReason } from "./project-orchestrator-types.js";

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
    const now = new Date().toISOString();
    const nowMs = Date.now();

    const reminderMode = project.reminderMode ?? "backoff";
    const maxRetries = this.context.reminderMaxCount ?? 5;
    const idleTimeoutMs = this.context.idleTimeoutMs ?? 60000;
    const backoffMultiplier = this.context.reminderBackoffMultiplier ?? 2;
    const maxIntervalMs = this.context.reminderMaxIntervalMs ?? 1800000;
    const roleSet = collectOrchestratorRoleSet({
      sessionRoles: sessions.map((session) => session.role),
      taskOwnerRoles: allTasks.map((task) => task.ownerRole)
    });

    for (const role of roleSet) {
      const activeSession = await resolveActiveSessionForRole({
        dataRoot: this.context.dataRoot,
        project,
        paths,
        role,
        reason: "check_idle_roles"
      });
      const roleSessions = activeSession ? [activeSession] : [];
      const currentRoleState = resolveRoleRuntimeState(roleSessions);
      const idleSession = resolveLatestIdleSession(roleSessions);
      const roleOpenTasks = allTasks
        .filter((task) => task.ownerRole === role && isRemindableTaskState(task.state))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const hasOpenTask = roleOpenTasks.length > 0;
      const sessionIdleSince = idleSession
        ? (idleSession.idleSince ?? idleSession.lastDispatchedAt ?? idleSession.updatedAt)
        : undefined;

      let reminderState = await this.context.repositories.projectRuntime.getRoleReminderState(
        paths,
        project.projectId,
        role
      );
      if (!reminderState) {
        reminderState = await this.context.repositories.projectRuntime.updateRoleReminderState(
          paths,
          project.projectId,
          role,
          {
            idleSince: sessionIdleSince,
            reminderCount: 0,
            lastRoleState: currentRoleState
          }
        );
      }

      reminderState = await this.context.repositories.projectRuntime.updateRoleReminderState(
        paths,
        project.projectId,
        role,
        {
          ...buildOrchestratorReminderRoleStatePatch({
            previousRoleState: reminderState.lastRoleState ?? "INACTIVE",
            currentRoleState,
            reminderMode,
            reminderCount: reminderState.reminderCount,
            nowMs,
            idleSince: sessionIdleSince,
            timing: {
              initialWaitMs: idleTimeoutMs,
              backoffMultiplier,
              maxWaitMs: maxIntervalMs
            }
          })
        }
      );

      const eligibility = evaluateOrchestratorReminderEligibility({
        currentRoleState,
        hasIdleSession: Boolean(idleSession),
        hasOpenTask,
        reminderCount: reminderState.reminderCount,
        maxRetries,
        idleSince: reminderState.idleSince,
        nextReminderAt: reminderState.nextReminderAt,
        nowMs
      });

      if (eligibility.reason === "skip_no_open_task") {
        await this.context.repositories.projectRuntime.updateRoleReminderState(paths, project.projectId, role, {
          reminderCount: 0,
          nextReminderAt: undefined,
          lastRoleState: "IDLE"
        });
        continue;
      }
      if (eligibility.reason === "schedule_missing_next_reminder") {
        await this.context.repositories.projectRuntime.updateRoleReminderState(paths, project.projectId, role, {
          ...buildOrchestratorReminderSchedulePatch({
            reminderMode,
            reminderCount: reminderState.reminderCount,
            nowMs,
            timing: {
              initialWaitMs: idleTimeoutMs,
              backoffMultiplier,
              maxWaitMs: maxIntervalMs
            }
          })
        });
        continue;
      }
      if (!eligibility.eligible || !idleSession) {
        continue;
      }
      reminderState = await this.context.repositories.projectRuntime.updateRoleReminderState(
        paths,
        project.projectId,
        role,
        {
          ...buildOrchestratorReminderTriggeredPatch({
            reminderMode,
            reminderCount: reminderState.reminderCount,
            nowMs,
            timing: {
              initialWaitMs: idleTimeoutMs,
              backoffMultiplier,
              maxWaitMs: maxIntervalMs
            }
          })
        }
      );

      const reminderRequestId = randomUUID();
      const reminderMessageId = randomUUID();
      const primaryTask = roleOpenTasks[0] ?? null;
      const primaryTaskId = primaryTask?.taskId ?? null;
      const openTaskSummary = buildOrchestratorReminderOpenTaskSummary(
        roleOpenTasks.map((task) => ({
          taskId: task.taskId,
          title: task.title
        }))
      );
      const reminderMessage = buildOrchestratorReminderMessage({
        scopeKind: "project",
        scopeId: project.projectId,
        role,
        reminderMode: reminderMode ?? "backoff",
        reminderCount: reminderState.reminderCount,
        nextReminderAt: null,
        openTasks: roleOpenTasks.map((task) => ({
          taskId: task.taskId,
          title: task.title
        })),
        content: buildOrchestratorReminderContent({
          openTaskCount: roleOpenTasks.length,
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
            reminderCount: reminderState?.reminderCount ?? 0,
            nextReminderAt: reminderState?.nextReminderAt ?? null,
            openTaskIds: openTaskSummary.openTaskIds,
            openTaskTitles: openTaskSummary.openTaskTitles
          }
        });
      });

      const redispatchResult = await this.context.dispatchProject(project.projectId, {
        mode: "loop",
        sessionId: idleSession.sessionId,
        force: false,
        onlyIdle: false,
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
  }
}
