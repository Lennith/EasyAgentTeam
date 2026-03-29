import assert from "node:assert/strict";
import test from "node:test";
import { clearMemoryStore, setStorageBackendForTests } from "../data/store/store-runtime.js";
import { getWorkflowRepositoryBundle } from "../data/repository/workflow-repository-bundle.js";

test("workflow repository bundle persists run runtime/session/event/inbox/reminder under a shared unit-of-work", async () => {
  const dataRoot = "C:\\memory\\workflow-repository-bundle";
  setStorageBackendForTests("memory");
  clearMemoryStore();
  const repositories = getWorkflowRepositoryBundle(dataRoot);

  try {
    await repositories.workflowRuns.createTemplate({
      templateId: "wf_repo_tpl",
      name: "Workflow Repo Template",
      tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
    });
    await repositories.workflowRuns.createRun({
      runId: "wf_repo_run",
      templateId: "wf_repo_tpl",
      name: "Workflow Repo Run",
      workspacePath: "C:\\workspace\\wf_repo_run",
      tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" }]
    });

    const scope = await repositories.resolveScope("wf_repo_run");
    assert.equal(scope.run.runId, "wf_repo_run");

    await repositories.runInUnitOfWork(scope, async () => {
      await repositories.workflowRuns.writeRuntime("wf_repo_run", {
        initializedAt: "2026-03-28T00:00:00.000Z",
        updatedAt: "2026-03-28T00:00:00.000Z",
        transitionSeq: 1,
        tasks: [
          {
            taskId: "task_a",
            state: "READY",
            blockedBy: [],
            blockedReasons: [],
            lastTransitionAt: "2026-03-28T00:00:00.000Z",
            transitionCount: 1,
            transitions: [{ seq: 1, at: "2026-03-28T00:00:00.000Z", fromState: null, toState: "READY" }]
          }
        ]
      });
      await repositories.sessions.upsertSession("wf_repo_run", {
        sessionId: "session-lead",
        role: "lead",
        status: "idle"
      });
      await repositories.events.appendEvent("wf_repo_run", {
        eventType: "ROLE_SESSION_CONFLICT_RESOLVED",
        source: "system",
        sessionId: "session-lead",
        payload: { role: "lead" }
      });
      await repositories.inbox.appendInboxMessage("wf_repo_run", "lead", {
        envelope: {
          message_id: "msg-1",
          run_id: "wf_repo_run",
          timestamp: "2026-03-28T00:00:00.000Z",
          sender: { type: "system", role: "manager", session_id: "manager-system" },
          via: { type: "manager" },
          intent: "MANAGER_MESSAGE",
          priority: "normal",
          correlation: { request_id: "req-1", task_id: "task_a" },
          accountability: {
            owner_role: "lead",
            report_to: { role: "manager", session_id: "manager-system" },
            expect: "TASK_REPORT"
          },
          dispatch_policy: "fixed_session"
        },
        body: {
          messageType: "MANAGER_MESSAGE",
          mode: "CHAT",
          content: "continue task_a",
          taskId: "task_a"
        }
      });
      await repositories.reminders.updateRoleReminderState("wf_repo_run", "lead", {
        reminderCount: 1,
        lastRoleState: "IDLE"
      });
      await repositories.workflowRuns.patchRun("wf_repo_run", {
        status: "running",
        autoDispatchRemaining: 3
      });
    });

    await repositories.runWithResolvedScope("wf_repo_run", async (resolvedScope) => {
      assert.equal(resolvedScope.run.runId, "wf_repo_run");
      await repositories.workflowRuns.patchRun(resolvedScope.run.runId, {
        description: "updated via shared scope"
      });
    });

    const runtime = await repositories.workflowRuns.readRuntime("wf_repo_run");
    const sessions = await repositories.sessions.listSessions("wf_repo_run");
    const events = await repositories.events.listEvents("wf_repo_run");
    const inbox = await repositories.inbox.listInboxMessages("wf_repo_run", "lead");
    const reminder = await repositories.reminders.getRoleReminderState("wf_repo_run", "lead");
    const run = await repositories.workflowRuns.getRun("wf_repo_run");

    assert.equal(runtime.tasks[0]?.state, "READY");
    assert.equal(sessions[0]?.sessionId, "session-lead");
    assert.equal(
      events.some((event) => event.eventType === "ROLE_SESSION_CONFLICT_RESOLVED"),
      true
    );
    assert.equal(inbox[0]?.envelope.message_id, "msg-1");
    assert.equal(reminder?.reminderCount, 1);
    assert.equal(run?.status, "running");
    assert.equal(run?.autoDispatchRemaining, 3);
    assert.equal(run?.description, "updated via shared scope");
  } finally {
    clearMemoryStore();
    setStorageBackendForTests(null);
  }
});
