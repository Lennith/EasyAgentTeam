import type { EventRecord, TaskDetailResponse, TaskLifecycleEvent, TaskRecord, TaskTreeNode } from "../domain/models.js";

function toTaskNode(task: TaskRecord): TaskTreeNode {
  return {
    task_id: task.taskId,
    task_detail_id: task.taskId,
    task_kind: task.taskKind,
    parent_task_id: task.parentTaskId,
    root_task_id: task.rootTaskId,
    title: task.title,
    state: task.state,
    creator_role: task.creatorRole ?? null,
    creator_session_id: task.creatorSessionId ?? null,
    owner_role: task.ownerRole,
    owner_session: task.ownerSession ?? null,
    priority: task.priority ?? 0,
    dependencies: [...task.dependencies],
    write_set: [...task.writeSet],
    acceptance: [...task.acceptance],
    artifacts: [...task.artifacts],
    alert: task.alert ?? null,
    granted_at: task.grantedAt ?? null,
    closed_at: task.closedAt ?? null,
    close_report_id: task.closeReportId ?? null,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    last_summary: task.lastSummary ?? null
  };
}

function normalizeLifecycleEvent(event: EventRecord): TaskLifecycleEvent {
  return {
    event_id: event.eventId,
    event_type: event.eventType,
    source: event.source,
    created_at: event.createdAt,
    session_id: event.sessionId ?? null,
    task_id: event.taskId ?? null,
    payload: event.payload
  };
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isEventRelatedToTask(event: EventRecord, taskId: string): boolean {
  if (event.taskId === taskId) {
    return true;
  }
  const payload = event.payload as Record<string, unknown>;
  if (readPayloadString(payload, "taskId") === taskId || readPayloadString(payload, "task_id") === taskId) {
    return true;
  }
  const updatedTaskIds = payload.updatedTaskIds;
  if (Array.isArray(updatedTaskIds) && updatedTaskIds.map((item) => String(item)).includes(taskId)) {
    return true;
  }
  const resultsRaw = payload.results;
  if (Array.isArray(resultsRaw)) {
    for (const row of resultsRaw) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const obj = row as Record<string, unknown>;
      if (readPayloadString(obj, "task_id") === taskId || readPayloadString(obj, "taskId") === taskId) {
        return true;
      }
    }
  }
  return false;
}

function buildCreateParameters(task: TaskRecord, lifecycle: EventRecord[]): Record<string, unknown> | null {
  const createAction = lifecycle.find((event) => {
    if (event.eventType !== "TASK_ACTION_RECEIVED") {
      return false;
    }
    const payload = event.payload as Record<string, unknown>;
    return readPayloadString(payload, "actionType") === "TASK_CREATE";
  });

  if (createAction) {
    return {
      source: "event_payload",
      ...(createAction.payload as Record<string, unknown>)
    };
  }

  return {
    source: "task_snapshot_fallback",
    task_id: task.taskId,
    task_kind: task.taskKind,
    parent_task_id: task.parentTaskId,
    root_task_id: task.rootTaskId,
    title: task.title,
    owner_role: task.ownerRole,
    owner_session: task.ownerSession ?? null,
    priority: task.priority ?? 0,
    dependencies: task.dependencies,
    write_set: task.writeSet,
    acceptance: task.acceptance,
    artifacts: task.artifacts
  };
}

interface BuildTaskDetailInput {
  projectId: string;
  task: TaskRecord;
  events: EventRecord[];
}

export function buildTaskDetailResponse(input: BuildTaskDetailInput): TaskDetailResponse {
  const relatedEvents = input.events
    .filter((event) => isEventRelatedToTask(event, input.task.taskId))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  return {
    project_id: input.projectId,
    task_id: input.task.taskId,
    task_detail_id: input.task.taskId,
    task: toTaskNode(input.task),
    created_by: {
      role: input.task.creatorRole ?? null,
      session_id: input.task.creatorSessionId ?? null
    },
    create_parameters: buildCreateParameters(input.task, relatedEvents),
    lifecycle: relatedEvents.map(normalizeLifecycleEvent),
    stats: {
      lifecycle_event_count: relatedEvents.length
    }
  };
}
