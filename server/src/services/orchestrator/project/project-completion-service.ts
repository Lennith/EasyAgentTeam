import fs from "node:fs/promises";
import path from "node:path";
import type { EventRecord, ProjectPaths, ProjectRecord, TaskRecord } from "../../../domain/models.js";
import { extractTaskIdFromMessage } from "../../orchestrator-dispatch-core.js";
import {
  hasSuccessfulRunFinishEvent,
  isTerminalTaskState,
  isValidAgentProgressContent
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
        const taskId = extractTaskIdFromMessage(message);
        const task = taskId ? taskById.get(taskId) : null;
        return task ? isTerminalTaskState(task.state) : false;
      })
      .map((message) => message.envelope.message_id);
    if (messageIds.length === 0) {
      return 0;
    }
    return this.context.repositories.inbox.removeInboxMessages(paths, role, messageIds);
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
