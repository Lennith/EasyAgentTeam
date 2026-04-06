import { randomUUID } from "node:crypto";
import { clearMemoryStore, setStorageBackendForTests } from "../../data/internal/persistence/store/store-runtime.js";
import { getProjectRepositoryBundle } from "../../data/repository/project/repository-bundle.js";

export function createMemoryProjectFixture(prefix: string) {
  const dataRoot = `C:\\memory\\${prefix}-${randomUUID()}`;
  setStorageBackendForTests("memory");
  clearMemoryStore();
  const repositories = getProjectRepositoryBundle(dataRoot);
  return {
    dataRoot,
    repositories,
    async createProject(projectId = `${prefix}-${randomUUID().slice(0, 8)}`) {
      const created = await repositories.projectRuntime.createProject({
        projectId,
        name: `Project ${projectId}`,
        workspacePath: `C:\\workspace\\${projectId}`,
        autoDispatchEnabled: true,
        autoDispatchRemaining: 5,
        holdEnabled: false,
        reminderMode: "backoff"
      });
      return created;
    },
    async createRootAndExecutionTask(projectId: string, ownerRole: string, executionTaskId = "task_exec") {
      const paths = await repositories.projectRuntime.ensureProjectRuntime(projectId);
      await repositories.taskboard.createTask(paths, projectId, {
        taskId: "root",
        taskKind: "PROJECT_ROOT",
        title: "Root",
        ownerRole
      });
      return repositories.taskboard.createTask(paths, projectId, {
        taskId: executionTaskId,
        taskKind: "EXECUTION",
        parentTaskId: "root",
        rootTaskId: "root",
        title: "Execution Task",
        ownerRole,
        state: "READY"
      });
    },
    cleanup() {
      clearMemoryStore();
      setStorageBackendForTests(null);
    }
  };
}
