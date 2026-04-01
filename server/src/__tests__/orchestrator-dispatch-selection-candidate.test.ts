import assert from "node:assert/strict";
import test from "node:test";
import { resolveOrchestratorDispatchCandidate } from "../services/orchestrator/shared/dispatch-selection-candidate.js";

type CandidateTask = {
  taskId: string;
  state: string;
  createdAt: string;
  parentTaskId?: string;
  priority?: number;
};

type CandidateMessage = {
  envelope: {
    timestamp: string;
    intent: string;
    correlation: {
      task_id?: string;
    };
  };
  body: Record<string, unknown>;
};

function createTask(input: Partial<CandidateTask> & Pick<CandidateTask, "taskId" | "state">): CandidateTask {
  return {
    taskId: input.taskId,
    state: input.state,
    createdAt: input.createdAt ?? "2026-03-29T00:00:00.000Z",
    parentTaskId: input.parentTaskId,
    priority: input.priority ?? 0
  };
}

function createMessage(messageType: string, taskId: string | null): CandidateMessage {
  return {
    envelope: {
      timestamp: "2026-03-29T00:00:00.000Z",
      intent: messageType,
      correlation: {
        task_id: taskId ?? undefined
      }
    },
    body: {
      messageType,
      ...(taskId ? { taskId } : {})
    }
  };
}

test("dispatch selection candidate prefers task/message selection when messages are present", () => {
  const taskA = createTask({ taskId: "task-a", state: "READY" });
  const message = createMessage("MANAGER_MESSAGE", "task-a");
  const result = resolveOrchestratorDispatchCandidate({
    messages: [message],
    runnableTasks: [taskA],
    allTasks: [taskA],
    force: false,
    resolveTaskById: (taskId) => (taskId === taskA.taskId ? taskA : null)
  });

  assert.notEqual(result, null);
  assert.equal(result?.dispatchKind, "message");
  assert.equal(result?.taskId, "task-a");
  assert.equal(result?.firstMessage, message);
});

test("dispatch selection candidate fallback skips MAY_BE_DONE when preferNonMayBeDoneOnFallback is enabled", () => {
  const mayBeDoneTask = createTask({ taskId: "task-a", state: "MAY_BE_DONE", createdAt: "2026-03-29T00:00:00.000Z" });
  const readyTask = createTask({ taskId: "task-b", state: "READY", createdAt: "2026-03-29T00:00:01.000Z" });
  const result = resolveOrchestratorDispatchCandidate({
    messages: [],
    runnableTasks: [mayBeDoneTask, readyTask],
    allTasks: [mayBeDoneTask, readyTask],
    force: false,
    preferNonMayBeDoneOnFallback: true,
    resolveTaskById: (taskId) =>
      taskId === mayBeDoneTask.taskId ? mayBeDoneTask : taskId === readyTask.taskId ? readyTask : null
  });

  assert.notEqual(result, null);
  assert.equal(result?.dispatchKind, "task");
  assert.equal(result?.taskId, "task-b");
  assert.equal(result?.firstMessage, null);
});

test("dispatch selection candidate returns null when fallback is disabled and no message selection exists", () => {
  const readyTask = createTask({ taskId: "task-a", state: "READY" });
  const result = resolveOrchestratorDispatchCandidate({
    messages: [],
    runnableTasks: [readyTask],
    allTasks: [readyTask],
    force: false,
    allowFallbackTask: false,
    resolveTaskById: () => readyTask
  });

  assert.equal(result, null);
});
