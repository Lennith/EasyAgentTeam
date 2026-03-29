import type { ProjectPaths, TaskRecord } from "../../domain/models.js";
import {
  createTask,
  getTask,
  getTaskDependencyGateStatus,
  listRunnableTasksByRole,
  listTasks,
  patchTask,
  recomputeRunnableStates,
  updateTaskboardFromTaskReport
} from "../taskboard-store.js";

export type TaskCreateInput = Parameters<typeof createTask>[2];
export type TaskPatchInput = Parameters<typeof patchTask>[3];
export type TaskPatchResult = Awaited<ReturnType<typeof patchTask>>;
export type RunnableTasksByRole = Awaited<ReturnType<typeof listRunnableTasksByRole>>;
export type TaskReportUpdateResult = Awaited<ReturnType<typeof updateTaskboardFromTaskReport>>;

export interface TaskboardRepository {
  listTasks(paths: ProjectPaths, projectId: string): Promise<TaskRecord[]>;
  getTask(paths: ProjectPaths, projectId: string, taskId: string): Promise<TaskRecord | null>;
  createTask(paths: ProjectPaths, projectId: string, input: TaskCreateInput): Promise<TaskRecord>;
  patchTask(paths: ProjectPaths, projectId: string, taskId: string, patch: TaskPatchInput): Promise<TaskPatchResult>;
  recomputeRunnableStates(paths: ProjectPaths, projectId: string): Promise<Awaited<ReturnType<typeof recomputeRunnableStates>>>;
  updateTaskboardFromTaskReport(paths: ProjectPaths, projectId: string, report: Parameters<typeof updateTaskboardFromTaskReport>[2]): Promise<TaskReportUpdateResult>;
  listRunnableTasksByRole(paths: ProjectPaths, projectId: string): Promise<RunnableTasksByRole>;
  getTaskDependencyGateStatus(task: TaskRecord, byId: Map<string, TaskRecord>): ReturnType<typeof getTaskDependencyGateStatus>;
}

class DefaultTaskboardRepository implements TaskboardRepository {
  listTasks(paths: ProjectPaths, projectId: string): Promise<TaskRecord[]> {
    return listTasks(paths, projectId);
  }

  getTask(paths: ProjectPaths, projectId: string, taskId: string): Promise<TaskRecord | null> {
    return getTask(paths, projectId, taskId);
  }

  createTask(paths: ProjectPaths, projectId: string, input: TaskCreateInput): Promise<TaskRecord> {
    return createTask(paths, projectId, input);
  }

  patchTask(paths: ProjectPaths, projectId: string, taskId: string, patch: TaskPatchInput): Promise<TaskPatchResult> {
    return patchTask(paths, projectId, taskId, patch);
  }

  recomputeRunnableStates(paths: ProjectPaths, projectId: string): Promise<Awaited<ReturnType<typeof recomputeRunnableStates>>> {
    return recomputeRunnableStates(paths, projectId);
  }

  updateTaskboardFromTaskReport(
    paths: ProjectPaths,
    projectId: string,
    report: Parameters<typeof updateTaskboardFromTaskReport>[2]
  ): Promise<TaskReportUpdateResult> {
    return updateTaskboardFromTaskReport(paths, projectId, report);
  }

  listRunnableTasksByRole(paths: ProjectPaths, projectId: string): Promise<RunnableTasksByRole> {
    return listRunnableTasksByRole(paths, projectId);
  }

  getTaskDependencyGateStatus(task: TaskRecord, byId: Map<string, TaskRecord>): ReturnType<typeof getTaskDependencyGateStatus> {
    return getTaskDependencyGateStatus(task, byId);
  }
}

export function createTaskboardRepository(): TaskboardRepository {
  return new DefaultTaskboardRepository();
}
