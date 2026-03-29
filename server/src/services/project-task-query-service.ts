import { listEvents } from "../data/event-store.js";
import { ensureProjectRuntime, getProject } from "../data/project-store.js";
import { listTasks } from "../data/taskboard-store.js";
import { buildTaskDetailResponse } from "./task-detail-query-service.js";
import { buildTaskTreeResponse } from "./task-tree-query-service.js";

export async function queryProjectTaskTree(input: {
  dataRoot: string;
  projectId: string;
  focusTaskId?: string;
  maxDescendantDepth?: number;
  includeExternalDependencies?: boolean;
}) {
  const project = await getProject(input.dataRoot, input.projectId);
  const paths = await ensureProjectRuntime(input.dataRoot, project.projectId);
  const tasks = await listTasks(paths, project.projectId);
  return buildTaskTreeResponse({
    projectId: project.projectId,
    tasks,
    focusTaskId: input.focusTaskId,
    maxDescendantDepth: input.maxDescendantDepth,
    includeExternalDependencies: input.includeExternalDependencies
  });
}

export async function queryProjectTaskDetail(input: { dataRoot: string; projectId: string; taskId: string }) {
  const project = await getProject(input.dataRoot, input.projectId);
  const paths = await ensureProjectRuntime(input.dataRoot, project.projectId);
  const tasks = await listTasks(paths, project.projectId);
  const task = tasks.find((item) => item.taskId === input.taskId);
  if (!task) {
    const error = new Error(`task '${input.taskId}' not found`) as Error & { code?: string };
    error.code = "TASK_NOT_FOUND";
    throw error;
  }
  const events = await listEvents(paths);
  return buildTaskDetailResponse({
    projectId: project.projectId,
    task,
    events
  });
}
