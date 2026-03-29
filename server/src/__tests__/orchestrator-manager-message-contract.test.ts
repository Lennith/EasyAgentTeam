import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOrchestratorRoutedManagerMessage,
  buildOrchestratorChatMessageBody,
  buildOrchestratorManagerChatMessage,
  buildOrchestratorMessageEnvelope,
  buildOrchestratorTaskAssignmentMessage
} from "../services/orchestrator/shared/index.js";

test("orchestrator manager message contract builds workflow envelope and chat body", () => {
  const message = buildOrchestratorManagerChatMessage({
    scopeKind: "workflow",
    scopeId: "run-1",
    messageId: "msg-1",
    createdAt: "2026-03-29T10:00:00.000Z",
    senderType: "system",
    senderRole: "manager",
    senderSessionId: "manager-system",
    intent: "TASK_DISCUSS",
    requestId: "req-1",
    parentRequestId: "parent-1",
    taskId: "task-1",
    ownerRole: "dev",
    reportToRole: "manager",
    reportToSessionId: "manager-system",
    expect: "DISCUSS_REPLY",
    messageType: "TASK_DISCUSS_REQUEST",
    content: "need discussion",
    discuss: { threadId: "thread-1" }
  });

  assert.deepEqual(message, {
    envelope: {
      message_id: "msg-1",
      run_id: "run-1",
      timestamp: "2026-03-29T10:00:00.000Z",
      sender: {
        type: "system",
        role: "manager",
        session_id: "manager-system"
      },
      via: { type: "manager" },
      intent: "TASK_DISCUSS",
      priority: "normal",
      correlation: {
        request_id: "req-1",
        parent_request_id: "parent-1",
        task_id: "task-1"
      },
      accountability: {
        owner_role: "dev",
        report_to: {
          role: "manager",
          session_id: "manager-system"
        },
        expect: "DISCUSS_REPLY"
      },
      dispatch_policy: "fixed_session"
    },
    body: {
      messageType: "TASK_DISCUSS_REQUEST",
      mode: "CHAT",
      content: "need discussion",
      taskId: "task-1",
      discuss: { threadId: "thread-1" }
    }
  });
});

test("orchestrator routed manager message builder keeps project/workflow routing contract", () => {
  const projectMessage = buildOrchestratorRoutedManagerMessage({
    scopeKind: "project",
    scopeId: "project-1",
    fromAgent: "manager",
    fromSessionId: "manager-system",
    messageType: "MANAGER_MESSAGE",
    resolvedRole: "dev",
    requestId: "req-project-1",
    messageId: "msg-project-1",
    createdAt: "2026-03-29T10:05:00.000Z",
    taskId: "task-1",
    content: "continue project flow"
  });

  const workflowMessage = buildOrchestratorRoutedManagerMessage({
    scopeKind: "workflow",
    scopeId: "run-1",
    fromAgent: "architect",
    fromSessionId: "session-architect-1",
    messageType: "TASK_DISCUSS_REQUEST",
    resolvedRole: "dev",
    requestId: "req-workflow-1",
    messageId: "msg-workflow-1",
    createdAt: "2026-03-29T10:06:00.000Z",
    taskId: "task-2",
    parentRequestId: "parent-workflow-1",
    content: "need status update",
    discuss: { threadId: "thread-1", requestId: "req-workflow-1" }
  });

  assert.equal(projectMessage.envelope.project_id, "project-1");
  assert.ok(projectMessage.envelope.accountability);
  assert.equal(projectMessage.envelope.accountability.owner_role, "dev");
  assert.equal(projectMessage.body.messageType, "MANAGER_MESSAGE");
  assert.equal(projectMessage.body.taskId, "task-1");

  assert.equal(workflowMessage.envelope.run_id, "run-1");
  assert.equal(workflowMessage.envelope.sender.type, "agent");
  assert.ok(workflowMessage.envelope.accountability);
  assert.equal(workflowMessage.envelope.accountability.expect, "DISCUSS_REPLY");
  assert.equal(workflowMessage.body.messageType, "TASK_DISCUSS_REQUEST");
});

test("orchestrator manager message contract builds project envelope", () => {
  const envelope = buildOrchestratorMessageEnvelope({
    scopeKind: "project",
    scopeId: "proj-1",
    messageId: "msg-2",
    createdAt: "2026-03-29T10:01:00.000Z",
    senderType: "system",
    senderRole: "manager",
    senderSessionId: "manager-system",
    intent: "TASK_ASSIGNMENT",
    requestId: "req-2",
    taskId: "task-2",
    ownerRole: "qa",
    reportToRole: "manager",
    reportToSessionId: "manager-system",
    expect: "TASK_REPORT"
  });

  assert.equal(envelope.project_id, "proj-1");
  assert.deepEqual(envelope.correlation, {
    request_id: "req-2",
    parent_request_id: undefined,
    task_id: "task-2"
  });
});

test("orchestrator chat message body keeps taskId/discuss nullable shape", () => {
  assert.deepEqual(
    buildOrchestratorChatMessageBody({
      messageType: "MANAGER_MESSAGE",
      content: "hello"
    }),
    {
      messageType: "MANAGER_MESSAGE",
      mode: "CHAT",
      content: "hello",
      taskId: null,
      discuss: null
    }
  );
});

test("orchestrator manager message contract builds task-assignment body through shared builder", () => {
  const message = buildOrchestratorTaskAssignmentMessage({
    scopeKind: "project",
    scopeId: "proj-assignment",
    messageId: "msg-assign-1",
    createdAt: "2026-03-29T12:00:00.000Z",
    senderType: "system",
    senderRole: "manager",
    senderSessionId: "manager-system",
    intent: "TASK_ASSIGNMENT",
    requestId: "req-assign-1",
    taskId: "task-a",
    ownerRole: "dev",
    reportToRole: "manager",
    reportToSessionId: "manager-system",
    expect: "TASK_REPORT",
    assignmentTaskId: "task-a",
    title: "Implement feature A",
    summary: "Focus on parser",
    task: {
      taskId: "task-a",
      taskKind: "EXECUTION",
      parentTaskId: "root-1",
      rootTaskId: "root-1",
      state: "READY",
      ownerRole: "dev",
      ownerSession: "session-dev-01",
      priority: 3,
      writeSet: ["src/a.ts"],
      dependencies: ["task-prep"],
      acceptance: ["tests pass"],
      artifacts: ["report.md"]
    }
  });

  assert.equal(message.body.messageType, "TASK_ASSIGNMENT");
  assert.equal(message.body.mode, "CHAT");
  assert.equal(message.body.taskId, "task-a");
  assert.deepEqual(message.body.task, {
    task_id: "task-a",
    task_kind: "EXECUTION",
    parent_task_id: "root-1",
    root_task_id: "root-1",
    state: "READY",
    owner_role: "dev",
    owner_session: "session-dev-01",
    priority: 3,
    write_set: ["src/a.ts"],
    dependencies: ["task-prep"],
    acceptance: ["tests pass"],
    artifacts: ["report.md"]
  });
});
