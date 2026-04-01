import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { listEvents } from "../data/event-store.js";
import { createProject } from "../data/project-store.js";
import {
  emitManagerMessageRouted,
  emitMessageRouted,
  emitUserMessageReceived
} from "../services/manager-routing-event-emitter-service.js";
import {
  buildManagerMessageRoutedPayload,
  buildMessageRoutedPayload,
  buildUserMessageReceivedPayload,
  buildWorkflowMessageReceivedPayload,
  buildWorkflowMessageRoutedPayload
} from "../services/manager-routing-event-service.js";

test("route event payload builders keep stable field contract", () => {
  const userPayload = buildUserMessageReceivedPayload({
    requestId: "req-1",
    content: "hello",
    fromAgent: "manager",
    mode: "CHAT",
    messageType: "CHAT"
  });
  assert.deepEqual(userPayload, {
    requestId: "req-1",
    parentRequestId: null,
    content: "hello",
    toRole: null,
    fromAgent: "manager",
    mode: "CHAT",
    messageType: "CHAT",
    taskId: null,
    discuss: null
  });

  const routedPayload = buildMessageRoutedPayload({
    requestId: "req-2",
    resolvedSessionId: "sess-planner-001",
    messageId: "msg-001",
    mode: "CHAT",
    messageType: "TASK_DISCUSS_REQUEST",
    content: "assign task",
    discuss: { thread_id: "thread-1", round: 1 },
    extras: {
      dispatchId: "dispatch-001"
    }
  });
  assert.deepEqual(routedPayload, {
    requestId: "req-2",
    parentRequestId: null,
    toRole: null,
    resolvedSessionId: "sess-planner-001",
    messageId: "msg-001",
    mode: "CHAT",
    messageType: "TASK_DISCUSS_REQUEST",
    taskId: null,
    discuss: { thread_id: "thread-1", round: 1 },
    content: "assign task",
    dispatchId: "dispatch-001"
  });

  const managerPayload = buildManagerMessageRoutedPayload({
    messageId: "msg-002",
    toSessionId: "sess-dev-001",
    type: "ASSIGN_TASK"
  });
  assert.deepEqual(managerPayload, {
    messageId: "msg-002",
    toSessionId: "sess-dev-001",
    toRole: null,
    type: "ASSIGN_TASK"
  });
  assert.equal(Object.prototype.hasOwnProperty.call(managerPayload, "mode"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(managerPayload, "requestId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(managerPayload, "content"), false);
});

test("workflow route event payload builders keep compact field contract stable", () => {
  const receivedPayload = buildWorkflowMessageReceivedPayload({
    requestId: "req-workflow-1",
    content: "please continue",
    toRole: "dev",
    fromAgent: "manager"
  });
  assert.deepEqual(receivedPayload, {
    fromAgent: "manager",
    toRole: "dev",
    requestId: "req-workflow-1",
    content: "please continue",
    sourceType: "manager",
    originAgent: "manager"
  });

  const routedPayload = buildWorkflowMessageRoutedPayload({
    fromAgent: "dev",
    toRole: "qa",
    resolvedSessionId: "session-qa-001",
    requestId: "req-workflow-2",
    messageId: "message-qa-001",
    content: "need verification",
    messageType: "TASK_DISCUSS_REPLY",
    discuss: { threadId: "thread-1", requestId: "req-workflow-2" }
  });
  assert.deepEqual(routedPayload, {
    fromAgent: "dev",
    toRole: "qa",
    resolvedSessionId: "session-qa-001",
    requestId: "req-workflow-2",
    messageId: "message-qa-001",
    content: "need verification",
    messageType: "TASK_DISCUSS_REPLY",
    discuss: { threadId: "thread-1", requestId: "req-workflow-2" },
    sourceType: "agent",
    originAgent: "dev"
  });
});

test("route event emitters persist normalized payload contract", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-route-event-contract-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "routecontract",
    name: "Route Contract",
    workspacePath: tempRoot
  });

  await emitUserMessageReceived(
    {
      projectId: "routecontract",
      paths: created.paths,
      source: "manager",
      sessionId: "sess-pm-001",
      taskId: "task-001"
    },
    {
      requestId: "req-user-001",
      parentRequestId: "dispatch-001",
      content: "build OTA product brief",
      toRole: "pm",
      fromAgent: "manager",
      mode: "CHAT",
      messageType: "CHAT",
      taskId: "task-001",
      discuss: { threadId: "dsc-001", round: 1 }
    }
  );

  await emitMessageRouted(
    {
      projectId: "routecontract",
      paths: created.paths,
      source: "manager",
      sessionId: "sess-pm-001",
      taskId: "task-001"
    },
    {
      requestId: "req-user-001",
      parentRequestId: "dispatch-001",
      toRole: "pm",
      resolvedSessionId: "sess-pm-001",
      messageId: "msg-pm-001",
      mode: "CHAT",
      messageType: "CHAT",
      taskId: "task-001",
      discuss: { threadId: "dsc-001", round: 1 },
      content: "build OTA product brief"
    }
  );

  await emitManagerMessageRouted(
    {
      projectId: "routecontract",
      paths: created.paths,
      source: "manager",
      sessionId: "sess-planner-001"
    },
    {
      messageId: "msg-plan-001",
      toSessionId: "sess-dev-001",
      toRole: "dev",
      type: "ASSIGN_TASK",
      mode: "CHAT",
      requestId: "req-report-001",
      content: "planner handoff to dev"
    }
  );

  const events = await listEvents(created.paths);
  assert.equal(events.length, 3);

  const user = events.find((event) => event.eventType === "USER_MESSAGE_RECEIVED");
  assert.ok(user);
  assert.equal(user.source, "manager");
  assert.equal(user.sessionId, "sess-pm-001");
  assert.equal(user.taskId, "task-001");
  assert.deepEqual(user.payload, {
    requestId: "req-user-001",
    parentRequestId: "dispatch-001",
    content: "build OTA product brief",
    toRole: "pm",
    fromAgent: "manager",
    mode: "CHAT",
    messageType: "CHAT",
    taskId: "task-001",
    discuss: { threadId: "dsc-001", round: 1 }
  });

  const routed = events.find((event) => event.eventType === "MESSAGE_ROUTED");
  assert.ok(routed);
  assert.equal(routed.source, "manager");
  assert.equal(routed.sessionId, "sess-pm-001");
  assert.equal(routed.taskId, "task-001");
  assert.deepEqual(routed.payload, {
    requestId: "req-user-001",
    parentRequestId: "dispatch-001",
    toRole: "pm",
    resolvedSessionId: "sess-pm-001",
    messageId: "msg-pm-001",
    mode: "CHAT",
    messageType: "CHAT",
    taskId: "task-001",
    discuss: { threadId: "dsc-001", round: 1 },
    content: "build OTA product brief"
  });

  const manager = events.find((event) => event.eventType === "MANAGER_MESSAGE_ROUTED");
  assert.ok(manager);
  assert.equal(manager.source, "manager");
  assert.equal(manager.sessionId, "sess-planner-001");
  assert.equal(manager.taskId, undefined);
  assert.deepEqual(manager.payload, {
    messageId: "msg-plan-001",
    toSessionId: "sess-dev-001",
    toRole: "dev",
    type: "ASSIGN_TASK",
    mode: "CHAT",
    requestId: "req-report-001",
    content: "planner handoff to dev"
  });
});
