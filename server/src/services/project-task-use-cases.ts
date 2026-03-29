import type { TaskPatchInput } from "../data/taskboard-store.js";
import { getProjectRepositoryBundle } from "../data/repository/project-repository-bundle.js";

export async function patchProjectTask(input: {
  dataRoot: string;
  projectId: string;
  taskId: string;
  patch: TaskPatchInput;
}) {
  const repositories = getProjectRepositoryBundle(input.dataRoot);
  const scope = await repositories.resolveScope(input.projectId);
  const { project, paths } = scope;
  return repositories.runInUnitOfWork(scope, async () => {
    const updated = await repositories.taskboard.patchTask(paths, project.projectId, input.taskId, input.patch);
    await repositories.taskboard.recomputeRunnableStates(paths, project.projectId);
    await repositories.events.appendEvent(paths, {
      projectId: project.projectId,
      eventType: "TASK_UPDATED",
      source: "dashboard",
      taskId: updated.task.taskId,
      payload: { updates: input.patch }
    });
    return updated;
  });
}
