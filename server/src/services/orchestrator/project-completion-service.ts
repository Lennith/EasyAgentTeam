import fs from "node:fs/promises";
import path from "node:path";
import type {
  EventRecord,
  ManagerToAgentMessage,
  ProjectPaths,
  ProjectRecord,
  TaskRecord
} from "../../domain/models.js";
import { extractTaskIdFromMessage } from "../orchestrator-dispatch-core.js";
import {
  countRecentTaskDispatches,
  hasSuccessfulRunFinishEvent,
  isTerminalTaskState,
  isValidAgentProgressContent,
  resolveProjectMayBeDoneSettings,
  shouldMarkTaskMayBeDone
} from "./project-completion-policy.js";
import type { ProjectCompletionContext } from "./project-orchestrator-types.js";

export class ProjectCompletionService {
  constructor(private readonly context: ProjectCompletionContext) {}

  async cleanupCompletedTaskMessages(paths: ProjectPaths, projectId: string, role: string): Promise<number> {
    const allTasks = await this.context.repositories.taskboard.listTasks(paths, projectId);
    const inboxMessages = await this.context.repositories.inbox.listInboxMessages(paths, role);
    const taskById = new Map(allTasks.map((task) => [task.taskId, task]));
    const messageIds = inboxMessages
      .filter((message) => {
        const taskId = extractTaskIdFromMessage(message as ManagerToAgentMessage);
        const task = taskId ? taskById.get(taskId) : null;
        return task ? isTerminalTaskState(task.state) : false;
      })
      .map((message) => message.envelope.message_id);
    if (messageIds.length === 0) {
      return 0;
    }
    return this.context.repositories.inbox.removeInboxMessages(paths, role, messageIds);
  }

  async checkAndMarkMayBeDone(project: ProjectRecord, paths: ProjectPaths): Promise<void> {
    const mayBeDoneSettings = resolveProjectMayBeDoneSettings();
    if (!mayBeDoneSettings.enabled) {
      return;
    }
    const { threshold, windowMs } = mayBeDoneSettings;

    const allTasks = await this.context.repositories.taskboard.listTasks(paths, project.projectId);
    const nonTerminalTasks = allTasks.filter((task) => !isTerminalTaskState(task.state));
    if (nonTerminalTasks.length === 0) {
      return;
    }

    const events = await this.context.repositories.events.listEvents(paths);
    const cutoff = Date.now() - windowMs;
    const recentEvents = events.filter((event) => Date.parse(event.createdAt) >= cutoff);

    for (const task of nonTerminalTasks) {
      const dispatchCount = countRecentTaskDispatches(task.taskId, recentEvents);
      const hasValidOutput = await this.hasValidAgentOutput(project, task, recentEvents);
      if (!shouldMarkTaskMayBeDone({ task, dispatchCount, threshold, hasValidOutput })) {
        continue;
      }
      await this.context.repositories.taskboard.patchTask(paths, project.projectId, task.taskId, {
        state: "MAY_BE_DONE"
      });
      await this.context.repositories.events.appendEvent(paths, {
        projectId: project.projectId,
        eventType: "TASK_MAY_BE_DONE_MARKED",
        source: "manager",
        taskId: task.taskId,
        payload: {
          dispatchCount,
          threshold,
          windowMs,
          reason: "dispatch_threshold_exceeded_with_valid_output"
        }
      });
    }
  }

  async emitDispatchObservabilitySnapshot(project: ProjectRecord, paths: ProjectPaths): Promise<void> {
    const now = Date.now();
    const last = this.context.lastObservabilityEventAt.get(project.projectId) ?? 0;
    if (now - last < 60_000) {
      return;
    }
    const events = await this.context.repositories.events.listEvents(paths);
    const cutoff = now - 60 * 60 * 1000;
    const recent = events.filter((item) => Date.parse(item.createdAt) >= cutoff);
    const runStarted = recent.filter((item) => item.eventType === "CODEX_RUN_STARTED");
    const dispatchStarted = recent.filter((item) => item.eventType === "ORCHESTRATOR_DISPATCH_STARTED");
    const runByTaskSession = new Map<string, number>();
    for (const item of runStarted) {
      const key = `${item.taskId ?? ""}::${item.sessionId ?? ""}`;
      runByTaskSession.set(key, (runByTaskSession.get(key) ?? 0) + 1);
    }
    const duplicateRunTaskSessionCount = Array.from(runByTaskSession.values()).filter((count) => count > 1).length;
    await this.context.repositories.events.appendEvent(paths, {
      projectId: project.projectId,
      eventType: "ORCHESTRATOR_OBSERVABILITY_SNAPSHOT",
      source: "manager",
      payload: {
        windowMinutes: 60,
        codexRunStartedCount: runStarted.length,
        dispatchStartedCount: dispatchStarted.length,
        duplicateRunTaskSessionCount
      }
    });
    this.context.lastObservabilityEventAt.set(project.projectId, now);
  }

  private async hasValidAgentOutput(
    project: ProjectRecord,
    task: TaskRecord,
    recentEvents: EventRecord[]
  ): Promise<boolean> {
    if ((task.lastSummary ?? "").trim().length > 0) {
      return true;
    }
    if (hasSuccessfulRunFinishEvent(task.taskId, recentEvents)) {
      return true;
    }
    if (!task.ownerRole) {
      return false;
    }
    try {
      const progressFile = path.resolve(project.workspacePath, "Agents", task.ownerRole, "progress.md");
      const content = await fs.readFile(progressFile, "utf8");
      return isValidAgentProgressContent(content);
    } catch {
      return false;
    }
  }
}
