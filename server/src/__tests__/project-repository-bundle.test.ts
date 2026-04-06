import assert from "node:assert/strict";
import test from "node:test";
import { getProjectRepositoryBundle } from "../data/repository/project/repository-bundle.js";
import { clearMemoryStore, setStorageBackendForTests } from "../data/internal/persistence/store/store-runtime.js";

test("project repository bundle exposes shared scope methods over one project unit-of-work", async () => {
  const dataRoot = "C:\\memory\\project-repository-bundle";
  setStorageBackendForTests("memory");
  clearMemoryStore();
  const repositories = getProjectRepositoryBundle(dataRoot);

  try {
    await repositories.projectRuntime.createProject({
      projectId: "project_repo_scope",
      name: "Project Repo Scope",
      workspacePath: "C:\\workspace\\project_repo_scope"
    });

    const scope = await repositories.resolveScope("project_repo_scope");
    assert.equal(scope.project.projectId, "project_repo_scope");
    assert.equal(scope.paths.projectRootDir.endsWith("project_repo_scope"), true);

    await repositories.runInUnitOfWork(scope, async () => {
      await repositories.taskboard.createTask(scope.paths, scope.project.projectId, {
        taskId: "task-root",
        taskKind: "EXECUTION",
        parentTaskId: "project_repo_scope-root",
        rootTaskId: "project_repo_scope-root",
        title: "Project scope task",
        ownerRole: "dev_backend",
        state: "READY"
      });
      await repositories.sessions.addSession(scope.paths, scope.project.projectId, {
        sessionId: "session-dev-1",
        role: "dev_backend",
        status: "idle"
      });
      await repositories.events.appendEvent(scope.paths, {
        projectId: scope.project.projectId,
        eventType: "PROJECT_SCOPE_TEST_EVENT",
        source: "system",
        taskId: "task-root",
        payload: { scope: "generic" }
      });
      await repositories.inbox.appendInboxMessage(scope.paths, "dev_backend", {
        envelope: {
          message_id: "msg-project-1",
          project_id: scope.project.projectId,
          timestamp: "2026-03-28T00:00:00.000Z",
          sender: { type: "system", role: "manager", session_id: "manager-system" },
          via: { type: "manager" },
          intent: "TASK_ASSIGNMENT",
          priority: "normal",
          correlation: { request_id: "req-project-1", task_id: "task-root" },
          accountability: {
            owner_role: "dev_backend",
            report_to: { role: "manager", session_id: "manager-system" },
            expect: "TASK_REPORT"
          },
          dispatch_policy: "fixed_session"
        },
        body: {
          messageType: "MANAGER_MESSAGE",
          mode: "CHAT",
          content: "continue task-root",
          taskId: "task-root"
        }
      });
      await repositories.projectRuntime.updateRoleReminderState(scope.paths, scope.project.projectId, "dev_backend", {
        reminderCount: 1,
        lastRoleState: "IDLE"
      });
    });

    await repositories.runWithResolvedScope("project_repo_scope", async (resolvedScope) => {
      assert.equal(resolvedScope.project.projectId, "project_repo_scope");
      await repositories.projectRuntime.updateProjectOrchestratorSettings(resolvedScope.project.projectId, {
        autoDispatchRemaining: 2
      });
    });

    const tasks = await repositories.taskboard.listTasks(scope.paths, scope.project.projectId);
    const sessions = await repositories.sessions.listSessions(scope.paths, scope.project.projectId);
    const events = await repositories.events.listEvents(scope.paths);
    const inbox = await repositories.inbox.listInboxMessages(scope.paths, "dev_backend");
    const reminder = await repositories.projectRuntime.getRoleReminderState(
      scope.paths,
      scope.project.projectId,
      "dev_backend"
    );
    const project = await repositories.projectRuntime.getProject(scope.project.projectId);

    assert.equal(
      tasks.some((task) => task.taskId === "task-root"),
      true
    );
    assert.equal(sessions[0]?.sessionId, "session-dev-1");
    assert.equal(
      events.some((event) => event.eventType === "PROJECT_SCOPE_TEST_EVENT"),
      true
    );
    assert.equal(inbox[0]?.envelope.message_id, "msg-project-1");
    assert.equal(reminder?.reminderCount, 1);
    assert.equal(project.autoDispatchRemaining, 2);
  } finally {
    clearMemoryStore();
    setStorageBackendForTests(null);
  }
});
