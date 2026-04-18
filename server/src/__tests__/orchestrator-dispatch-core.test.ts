import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRemindableTaskState,
  selectTaskForDispatch,
  sortTasksForDispatch,
  type DispatchMessageLike,
  type DispatchTaskLike
} from "../services/orchestrator-dispatch-core.js";

interface TestTask extends DispatchTaskLike {
  parentTaskId?: string;
  priority?: number;
}

interface TestMessage extends DispatchMessageLike {
  envelope: DispatchMessageLike["envelope"] & { timestamp?: string };
  body: {
    messageType?: string;
    taskId?: string;
  };
}

function createMessage(input: { taskId?: string; messageType?: string; timestamp: string }): TestMessage {
  return {
    envelope: {
      timestamp: input.timestamp,
      correlation: input.taskId ? { task_id: input.taskId } : {}
    },
    body: {
      messageType: input.messageType,
      taskId: input.taskId
    }
  };
}

test("isRemindableTaskState aligns reminder candidates with actionable dispatch states", () => {
  assert.equal(isRemindableTaskState("READY"), true);
  assert.equal(isRemindableTaskState("DISPATCHED"), true);
  assert.equal(isRemindableTaskState("IN_PROGRESS"), true);

  assert.equal(isRemindableTaskState("PLANNED"), false);
  assert.equal(isRemindableTaskState("BLOCKED_DEP"), false);
  assert.equal(isRemindableTaskState("DONE"), false);
  assert.equal(isRemindableTaskState("CANCELED"), false);
  assert.equal(isRemindableTaskState(" ready "), true);
  assert.equal(isRemindableTaskState(undefined), false);
});

test("sortTasksForDispatch prioritizes deeper tasks before shallower ones", () => {
  const tasks: TestTask[] = [
    { taskId: "phase", state: "READY", createdAt: "2026-03-17T00:00:01.000Z", priority: 1, parentTaskId: "root" },
    {
      taskId: "leaf",
      state: "READY",
      createdAt: "2026-03-17T00:00:10.000Z",
      priority: 0,
      parentTaskId: "phase"
    },
    { taskId: "root", state: "IN_PROGRESS", createdAt: "2026-03-17T00:00:00.000Z", priority: 0 }
  ];

  const sorted = sortTasksForDispatch(
    tasks.filter((task) => task.state === "READY"),
    tasks
  );
  assert.deepEqual(
    sorted.map((item) => item.taskId),
    ["leaf", "phase"]
  );
});

test("sortTasksForDispatch uses priority then createdAt then taskId when depth is equal", () => {
  const tasks: TestTask[] = [
    {
      taskId: "task_high_priority",
      state: "READY",
      createdAt: "2026-03-17T00:00:10.000Z",
      priority: 10,
      parentTaskId: "root"
    },
    {
      taskId: "task_early_low_priority",
      state: "READY",
      createdAt: "2026-03-17T00:00:01.000Z",
      priority: 1,
      parentTaskId: "root"
    },
    {
      taskId: "task_late_low_priority",
      state: "READY",
      createdAt: "2026-03-17T00:00:05.000Z",
      priority: 1,
      parentTaskId: "root"
    },
    { taskId: "root", state: "IN_PROGRESS", createdAt: "2026-03-17T00:00:00.000Z", priority: 0 }
  ];

  const sorted = sortTasksForDispatch(
    tasks.filter((task) => task.state === "READY"),
    tasks
  );
  assert.deepEqual(
    sorted.map((item) => item.taskId),
    ["task_high_priority", "task_early_low_priority", "task_late_low_priority"]
  );
});

test("selectTaskForDispatch picks deepest TASK_ASSIGNMENT candidate regardless of message order", () => {
  const allTasks: TestTask[] = [
    { taskId: "root", state: "IN_PROGRESS", createdAt: "2026-03-17T00:00:00.000Z" },
    { taskId: "task_parent", state: "READY", parentTaskId: "root", createdAt: "2026-03-17T00:00:01.000Z", priority: 5 },
    {
      taskId: "task_leaf",
      state: "READY",
      parentTaskId: "task_parent",
      createdAt: "2026-03-17T00:00:02.000Z",
      priority: 1
    }
  ];
  const runnable = allTasks.filter((task) => task.state === "READY");
  const messages: TestMessage[] = [
    createMessage({ taskId: "task_parent", messageType: "TASK_ASSIGNMENT", timestamp: "2026-03-17T00:00:01.000Z" }),
    createMessage({ taskId: "task_leaf", messageType: "TASK_ASSIGNMENT", timestamp: "2026-03-17T00:00:02.000Z" })
  ];

  const selection = selectTaskForDispatch(messages, runnable, allTasks);
  assert.ok(selection);
  assert.equal(selection?.dispatchKind, "task");
  assert.equal(selection?.taskId, "task_leaf");
});
