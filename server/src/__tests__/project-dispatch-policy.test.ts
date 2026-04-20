import assert from "node:assert/strict";
import test from "node:test";
import {
  areTaskDependenciesSatisfied,
  buildPendingSessionId,
  isForceDispatchableState,
  resolveTaskDiscuss,
  sessionMatchesOwnerToken
} from "../services/orchestrator/project/project-dispatch-policy.js";

test("project dispatch policy builds pending session ids and matches owner token", () => {
  const sessionId = buildPendingSessionId("dev-role");
  assert.match(sessionId, /^session-dev-role-/);
  assert.equal(sessionMatchesOwnerToken({ sessionId: "session-dev", role: "dev" } as any, "session-dev"), true);
  assert.equal(sessionMatchesOwnerToken({ sessionId: "session-dev", role: "dev" } as any, "session-other"), false);
  assert.equal(isForceDispatchableState("READY"), true);
  assert.equal(isForceDispatchableState("DONE"), false);
});

test("project dispatch policy closes dependency gate until prerequisite is done", () => {
  const tasks = [
    {
      taskId: "root",
      parentTaskId: "root",
      rootTaskId: "root",
      ownerRole: "lead",
      creatorRole: "lead",
      title: "Root",
      taskKind: "PROJECT_ROOT",
      state: "DONE",
      dependencies: [],
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z"
    },
    {
      taskId: "dep",
      parentTaskId: "root",
      rootTaskId: "root",
      ownerRole: "dev",
      creatorRole: "lead",
      title: "Dependency",
      taskKind: "EXECUTION",
      state: "IN_PROGRESS",
      dependencies: [],
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z"
    },
    {
      taskId: "target",
      parentTaskId: "root",
      rootTaskId: "root",
      ownerRole: "dev",
      creatorRole: "lead",
      title: "Target",
      taskKind: "EXECUTION",
      state: "READY",
      dependencies: ["dep"],
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z"
    }
  ] as any[];

  const blocked = areTaskDependenciesSatisfied(tasks[2], tasks as any);
  assert.equal(blocked.satisfied, false);
  assert.deepEqual(blocked.unsatisfiedDeps, ["dep"]);

  tasks[1].state = "DONE";
  const ready = areTaskDependenciesSatisfied(tasks[2], tasks as any);
  assert.equal(ready.satisfied, true);
  assert.deepEqual(ready.unsatisfiedDeps, []);
});

test("project dispatch policy remaps discuss message to correct child task for target role", () => {
  const message = {
    envelope: {
      message_id: "msg-1",
      project_id: "project",
      timestamp: "2026-03-28T00:00:00.000Z",
      sender: { type: "agent", role: "qa", session_id: "s-qa" },
      via: { type: "manager" },
      intent: "TASK_DISCUSS",
      priority: "normal",
      correlation: { request_id: "req-1", task_id: "parent-task" },
      accountability: {
        owner_role: "dev",
        report_to: { role: "qa", session_id: "s-qa" },
        expect: "TASK_REPORT"
      },
      dispatch_policy: "fixed_session"
    },
    body: {
      messageType: "TASK_DISCUSS_REQUEST",
      taskId: "parent-task"
    }
  } as any;
  const tasks = [
    {
      taskId: "parent-task",
      parentTaskId: "parent-task",
      rootTaskId: "parent-task",
      ownerRole: "qa",
      creatorRole: "dev",
      state: "READY"
    },
    {
      taskId: "child-dev",
      parentTaskId: "parent-task",
      rootTaskId: "parent-task",
      ownerRole: "dev",
      creatorRole: "qa",
      state: "READY"
    }
  ] as any[];

  const resolved = resolveTaskDiscuss(message, "dev", tasks as any);
  assert.equal(resolved.body.taskId, "child-dev");
  assert.equal(resolved.envelope.correlation.task_id, "child-dev");
});

test("project dispatch policy remaps discuss reply to dependent active task for target role", () => {
  const message = {
    envelope: {
      message_id: "msg-2",
      project_id: "project",
      timestamp: "2026-03-28T00:00:00.000Z",
      sender: { type: "agent", role: "arch-d", session_id: "s-d" },
      via: { type: "manager" },
      intent: "TASK_DISCUSS",
      priority: "normal",
      correlation: { request_id: "req-2", task_id: "task-discuss-arch-d" },
      accountability: {
        owner_role: "lead",
        report_to: { role: "arch-d", session_id: "s-d" },
        expect: "TASK_REPORT"
      },
      dispatch_policy: "fixed_session"
    },
    body: {
      messageType: "TASK_DISCUSS_REPLY",
      taskId: "task-discuss-arch-d",
      discuss: {
        thread_id: "task-discuss-lead-plan-20260420T0527Z-d",
        round: 2
      }
    }
  } as any;
  const tasks = [
    {
      taskId: "task-discuss-arch-d",
      parentTaskId: "root",
      rootTaskId: "root",
      ownerRole: "arch-d",
      creatorRole: "manager",
      state: "DONE",
      dependencies: []
    },
    {
      taskId: "task-discuss-alignment",
      parentTaskId: "root",
      rootTaskId: "root",
      ownerRole: "lead",
      creatorRole: "manager",
      state: "DISPATCHED",
      dependencies: ["task-discuss-arch-d"],
      priority: 80,
      createdAt: "2026-03-28T00:00:00.000Z"
    },
    {
      taskId: "task-discuss-final-consensus",
      parentTaskId: "root",
      rootTaskId: "root",
      ownerRole: "lead",
      creatorRole: "manager",
      state: "BLOCKED_DEP",
      dependencies: ["task-discuss-alignment"],
      priority: 70,
      createdAt: "2026-03-28T00:01:00.000Z"
    }
  ] as any[];

  const resolved = resolveTaskDiscuss(message, "lead", tasks as any);
  assert.equal(resolved.body.taskId, "task-discuss-alignment");
  assert.equal(resolved.envelope.correlation.task_id, "task-discuss-alignment");
});
