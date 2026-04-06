import type { ProjectPaths, ProjectRecord, TaskActionResult } from "../../domain/models.js";
import type { ProjectRepositoryBundle } from "../../data/repository/project/repository-bundle.js";
import type { TaskPatchInput } from "../../data/repository/project/taskboard-repository.js";
import { readString, readStringList } from "./shared.js";
import { TaskActionError } from "./types.js";

export interface ApplyTaskUpdateActionInput {
  project: ProjectRecord;
  paths: ProjectPaths;
  repositories: ProjectRepositoryBundle;
  actionInput: Record<string, unknown>;
  requestId: string;
  fromSessionId: string;
  defaultTaskId?: string;
}

export async function applyTaskUpdateAction(input: ApplyTaskUpdateActionInput): Promise<TaskActionResult> {
  const taskId = readString(input.actionInput.task_id) ?? readString(input.actionInput.taskId) ?? input.defaultTaskId;
  if (!taskId) {
    throw new TaskActionError("TASK_UPDATE requires task_id", "TASK_BINDING_REQUIRED", 400);
  }
  const existing = await input.repositories.taskboard.getTask(input.paths, input.project.projectId, taskId);
  if (!existing) {
    throw new TaskActionError(`task '${taskId}' not found`, "TASK_NOT_FOUND", 404);
  }
  const patch: TaskPatchInput = {};
  if (Object.prototype.hasOwnProperty.call(input.actionInput, "title")) {
    patch.title = readString(input.actionInput.title) ?? undefined;
  }
  if (Object.prototype.hasOwnProperty.call(input.actionInput, "dependencies")) {
    patch.dependencies = readStringList(input.actionInput.dependencies);
  }
  if (
    Object.prototype.hasOwnProperty.call(input.actionInput, "write_set") ||
    Object.prototype.hasOwnProperty.call(input.actionInput, "writeSet")
  ) {
    patch.writeSet = readStringList(input.actionInput.write_set ?? input.actionInput.writeSet);
  }
  if (Object.prototype.hasOwnProperty.call(input.actionInput, "acceptance")) {
    patch.acceptance = readStringList(input.actionInput.acceptance);
  }
  if (Object.prototype.hasOwnProperty.call(input.actionInput, "artifacts")) {
    patch.artifacts = readStringList(input.actionInput.artifacts);
  }
  if (Object.prototype.hasOwnProperty.call(input.actionInput, "priority")) {
    const priority = Number(input.actionInput.priority);
    if (Number.isFinite(priority)) {
      patch.priority = Math.floor(priority);
    }
  }
  if (Object.prototype.hasOwnProperty.call(input.actionInput, "alert")) {
    patch.alert = readString(input.actionInput.alert) ?? null;
  }
  const patched = await input.repositories.taskboard.patchTask(input.paths, input.project.projectId, taskId, patch);
  await input.repositories.taskboard.recomputeRunnableStates(input.paths, input.project.projectId);
  await input.repositories.events.appendEvent(input.paths, {
    projectId: input.project.projectId,
    eventType: "TASK_UPDATED",
    source: "manager",
    sessionId: input.fromSessionId,
    taskId: patched.task.taskId,
    payload: {
      requestId: input.requestId,
      updates: patch
    }
  });
  return {
    success: true,
    requestId: input.requestId,
    actionType: "TASK_UPDATE",
    taskId: patched.task.taskId
  };
}
