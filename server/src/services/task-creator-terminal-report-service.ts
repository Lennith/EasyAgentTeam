import { randomUUID } from "node:crypto";
import type { ProjectPaths, ProjectRecord, TaskRecord } from "../domain/models.js";
import { getProjectRepositoryBundle } from "../data/repository/project-repository-bundle.js";
import { deliverProjectMessage } from "./orchestrator/project-message-routing-service.js";
import { resolveActiveSessionForRole } from "./session-lifecycle-authority.js";

const TERMINAL = new Set(["DONE", "BLOCKED_DEP", "CANCELED"]);
const SYSTEM_ROLES = new Set(["manager", "user", "system", "dashboard"]);

interface TaskGroupSummary {
  creatorRole: string;
  creatorSessionId: string;
  parentTaskId: string;
  tasks: TaskRecord[];
}

function buildGroupKey(group: TaskGroupSummary): string {
  return `${group.creatorRole}::${group.creatorSessionId || "-"}::${group.parentTaskId}`;
}

function buildSignature(tasks: TaskRecord[]): string {
  const parts = [...tasks]
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
    .map((task) => `${task.taskId}:${task.state}`);
  return parts.join("|");
}

function aggregateStatus(tasks: TaskRecord[]): "DONE" | "BLOCKED" | "FAILED" {
  if (tasks.some((task) => task.state === "CANCELED")) {
    return "FAILED";
  }
  if (tasks.some((task) => task.state === "BLOCKED_DEP")) {
    return "BLOCKED";
  }
  return "DONE";
}

function buildGroups(tasks: TaskRecord[]): TaskGroupSummary[] {
  const grouped = new Map<string, TaskGroupSummary>();
  for (const task of tasks) {
    const creatorRole = task.creatorRole?.trim() ?? "";
    if (!creatorRole || SYSTEM_ROLES.has(creatorRole)) {
      continue;
    }
    if (!task.parentTaskId) {
      continue;
    }
    const creatorSessionId = task.creatorSessionId?.trim() ?? "";
    const key = `${creatorRole}::${creatorSessionId || "-"}::${task.parentTaskId}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        creatorRole,
        creatorSessionId,
        parentTaskId: task.parentTaskId,
        tasks: []
      });
    }
    grouped.get(key)!.tasks.push(task);
  }
  return Array.from(grouped.values());
}

export async function emitCreatorTerminalReportsIfReady(
  dataRoot: string,
  project: ProjectRecord,
  paths: ProjectPaths,
  triggerRequestId?: string
): Promise<void> {
  const repositories = getProjectRepositoryBundle(dataRoot);
  const tasks = await repositories.taskboard.listTasks(paths, project.projectId);
  const groups = buildGroups(tasks).filter((group) => group.tasks.length > 0);
  if (groups.length === 0) {
    return;
  }
  const events = await repositories.events.listEvents(paths);
  const latestSignatureByGroup = new Map<string, string>();
  for (const event of events) {
    if (event.eventType !== "TASK_CREATOR_TERMINAL_REPORT_SENT") {
      continue;
    }
    const groupKey = typeof event.payload.groupKey === "string" ? event.payload.groupKey : "";
    const signature = typeof event.payload.signature === "string" ? event.payload.signature : "";
    if (groupKey && signature) {
      latestSignatureByGroup.set(groupKey, signature);
    }
  }

  for (const group of groups) {
    if (!group.tasks.every((task) => TERMINAL.has(task.state))) {
      continue;
    }
    const groupKey = buildGroupKey(group);
    const signature = buildSignature(group.tasks);
    if (latestSignatureByGroup.get(groupKey) === signature) {
      await repositories.events.appendEvent(paths, {
        projectId: project.projectId,
        eventType: "TASK_CREATOR_TERMINAL_REPORT_SKIPPED",
        source: "system",
        payload: {
          reason: "duplicate_signature",
          groupKey,
          signature
        }
      });
      continue;
    }

    const preferredSession =
      group.creatorSessionId || repositories.projectRuntime.resolveSessionByRole(project, group.creatorRole);
    let targetSessionId = preferredSession;
    if (!targetSessionId) {
      const latest = await resolveActiveSessionForRole({
        dataRoot,
        project,
        paths,
        role: group.creatorRole,
        reason: "creator_terminal_report"
      });
      targetSessionId = latest?.sessionId;
    }
    if (!targetSessionId) {
      await repositories.events.appendEvent(paths, {
        projectId: project.projectId,
        eventType: "TASK_CREATOR_TERMINAL_REPORT_SKIPPED",
        source: "system",
        payload: {
          reason: "target_session_unavailable",
          groupKey,
          signature
        }
      });
      continue;
    }

    const status = aggregateStatus(group.tasks);
    const counts = {
      done: group.tasks.filter((task) => task.state === "DONE").length,
      blocked: group.tasks.filter((task) => task.state === "BLOCKED_DEP").length,
      failed: group.tasks.filter((task) => task.state === "CANCELED").length,
      total: group.tasks.length
    };
    const messageId = randomUUID();
    const requestId = randomUUID();
    await deliverProjectMessage({
      dataRoot,
      project,
      paths,
      targetRole: group.creatorRole,
      targetSessionId,
      message: {
        envelope: {
          message_id: messageId,
          project_id: project.projectId,
          timestamp: new Date().toISOString(),
          sender: {
            type: "system",
            role: "manager",
            session_id: "manager-system"
          },
          via: { type: "manager" },
          intent: "SYSTEM_NOTICE",
          priority: "normal",
          correlation: {
            request_id: requestId,
            parent_request_id: triggerRequestId,
            task_id: group.parentTaskId
          }
        },
        body: {
          mode: "CHAT",
          messageType: "TASK_CREATOR_TERMINAL_REPORT",
          taskId: group.parentTaskId,
          report: {
            aggregate_status: status,
            counts,
            parent_task_id: group.parentTaskId,
            creator_role: group.creatorRole,
            creator_session_id: group.creatorSessionId || null,
            tasks: group.tasks.map((task) => ({
              task_id: task.taskId,
              state: task.state,
              owner_role: task.ownerRole,
              owner_session: task.ownerSession ?? null,
              close_report_id: task.closeReportId ?? null,
              last_summary: task.lastSummary ?? null
            }))
          }
        }
      }
    });

    await repositories.events.appendEvent(paths, {
      projectId: project.projectId,
      eventType: "TASK_CREATOR_TERMINAL_REPORT_SENT",
      source: "system",
      sessionId: targetSessionId,
      taskId: group.parentTaskId,
      payload: {
        groupKey,
        signature,
        targetSessionId,
        aggregateStatus: status,
        counts
      }
    });
  }
}
