import type {
  EventRecord,
  TaskDetailResponse,
  TaskRecord,
  TaskTreeResponse,
  WorkflowRunEventRecord,
  WorkflowRunRecord,
  WorkflowTaskRuntimeRecord
} from "../domain/models.js";
import { buildTaskDetailResponse } from "./task-detail-query-service.js";
import { buildTaskTreeResponse } from "./task-tree-query-service.js";

function buildSyntheticRootTask(run: WorkflowRunRecord, rootTaskId: string): TaskRecord {
  return {
    taskId: rootTaskId,
    taskKind: "PROJECT_ROOT",
    parentTaskId: rootTaskId,
    rootTaskId,
    title: `${run.name} Root`,
    creatorRole: "manager",
    creatorSessionId: "manager-system",
    ownerRole: "manager",
    ownerSession: undefined,
    state: "DONE",
    priority: 0,
    writeSet: [],
    dependencies: [],
    acceptance: [],
    artifacts: [],
    alert: undefined,
    grantedAt: run.startedAt,
    closedAt: run.startedAt,
    closeReportId: undefined,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    lastSummary: "synthetic root"
  };
}

function toEventRecord(runId: string, event: WorkflowRunEventRecord): EventRecord {
  return {
    schemaVersion: "1.0",
    eventId: event.eventId,
    projectId: runId,
    eventType: event.eventType,
    source: event.source,
    createdAt: event.createdAt,
    sessionId: event.sessionId,
    taskId: event.taskId,
    payload: event.payload
  };
}

export function buildWorkflowTaskRecords(
  run: WorkflowRunRecord,
  runtimeTasks: WorkflowTaskRuntimeRecord[]
): { rootTaskId: string; tasks: TaskRecord[] } {
  const runtimeById = new Map(runtimeTasks.map((item) => [item.taskId, item]));
  const taskIds = new Set(run.tasks.map((item) => item.taskId));
  const rootTaskId = `${run.runId}__root`;
  const tasks: TaskRecord[] = [buildSyntheticRootTask(run, rootTaskId)];
  for (const task of run.tasks) {
    const runtime = runtimeById.get(task.taskId);
    const parentTaskIdRaw = task.parentTaskId?.trim();
    const parentTaskId = parentTaskIdRaw && taskIds.has(parentTaskIdRaw) ? parentTaskIdRaw : rootTaskId;
    const lastTransitionAt = runtime?.lastTransitionAt ?? run.updatedAt;
    tasks.push({
      taskId: task.taskId,
      taskKind: "EXECUTION",
      parentTaskId,
      rootTaskId,
      title: task.resolvedTitle,
      creatorRole: task.creatorRole,
      creatorSessionId: task.creatorSessionId,
      ownerRole: task.ownerRole,
      ownerSession: undefined,
      state: runtime?.state ?? "PLANNED",
      priority: 0,
      writeSet: [...(task.writeSet ?? [])],
      dependencies: [...(task.dependencies ?? [])],
      acceptance: [...(task.acceptance ?? [])],
      artifacts: [...(task.artifacts ?? [])],
      alert: undefined,
      grantedAt: undefined,
      closedAt: runtime?.state === "DONE" || runtime?.state === "CANCELED" ? lastTransitionAt : undefined,
      closeReportId: undefined,
      createdAt: run.createdAt,
      updatedAt: lastTransitionAt,
      lastSummary: runtime?.lastSummary
    });
  }
  return { rootTaskId, tasks };
}

export function buildWorkflowTaskTreeResponse(input: {
  run: WorkflowRunRecord;
  runtimeTasks: WorkflowTaskRuntimeRecord[];
  focusTaskId?: string;
  maxDescendantDepth?: number;
  includeExternalDependencies?: boolean;
}): TaskTreeResponse {
  const projection = buildWorkflowTaskRecords(input.run, input.runtimeTasks);
  return buildTaskTreeResponse({
    projectId: input.run.runId,
    tasks: projection.tasks,
    focusTaskId: input.focusTaskId,
    maxDescendantDepth: input.maxDescendantDepth,
    includeExternalDependencies: input.includeExternalDependencies
  });
}

export function buildWorkflowTaskDetail(input: {
  run: WorkflowRunRecord;
  runtimeTasks: WorkflowTaskRuntimeRecord[];
  taskId: string;
  events: WorkflowRunEventRecord[];
}): TaskDetailResponse {
  const projection = buildWorkflowTaskRecords(input.run, input.runtimeTasks);
  const task = projection.tasks.find((item) => item.taskId === input.taskId);
  if (!task) {
    const err = new Error(`task '${input.taskId}' not found`);
    (err as Error & { code?: string }).code = "TASK_NOT_FOUND";
    throw err;
  }
  return buildTaskDetailResponse({
    projectId: input.run.runId,
    task,
    events: input.events.map((event) => toEventRecord(input.run.runId, event))
  });
}
