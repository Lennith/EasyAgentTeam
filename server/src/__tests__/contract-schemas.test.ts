import assert from "node:assert/strict";
import test from "node:test";
import {
  TeamToolErrorPayloadSchema,
  WorkflowMessageSendPublicRequestSchema,
  WorkflowMessageSendRequestSchema,
  WorkflowTaskActionPublicRequestSchema,
  WorkflowTaskActionRequestSchema,
  WorkflowTemplatePublicPayloadSchema,
  WorkflowTemplatePayloadSchema
} from "@autodev/agent-library";

test("workflow task action schema accepts current valid TASK_CREATE and rejects invalid TASK_REPORT", () => {
  const create = WorkflowTaskActionRequestSchema.parse({
    action_type: "TASK_CREATE",
    from_agent: "architect",
    from_session_id: "session-1",
    task: {
      task_id: "task-1",
      title: "Implement contract",
      owner_role: "architect",
      dependencies: ["task-0"]
    }
  });
  assert.equal(create.actionType, "TASK_CREATE");
  assert.equal(create.task?.taskId, "task-1");
  assert.equal(create.task?.ownerRole, "architect");

  assert.equal(
    WorkflowTaskActionRequestSchema.safeParse({
      action_type: "TASK_REPORT",
      results: [{ task_id: "task-1", outcome: "UNKNOWN" }]
    }).success,
    false
  );
});

test("workflow task action schema rejects invalid TASK_CREATE", () => {
  assert.equal(
    WorkflowTaskActionRequestSchema.safeParse({
      action_type: "TASK_CREATE",
      task: {
        task_id: "task-1",
        title: "Missing owner"
      }
    }).success,
    false
  );
  assert.equal(WorkflowTaskActionPublicRequestSchema.safeParse({ task_id: "task-1" }).success, false);
});

test("workflow template schema normalizes public API payload", () => {
  const template = WorkflowTemplatePayloadSchema.parse({
    template_id: "template-1",
    name: "Template",
    tasks: [
      {
        task_id: "task-1",
        title: "Task",
        owner_role: "developer",
        write_set: ["src"]
      }
    ],
    route_table: {
      developer: ["qa"]
    },
    default_variables: {
      product: "demo"
    }
  });

  assert.equal(template.templateId, "template-1");
  assert.equal(template.tasks[0]?.taskId, "task-1");
  assert.deepEqual(template.routeTable, { developer: ["qa"] });
  assert.deepEqual(template.defaultVariables, { product: "demo" });
  assert.equal(
    WorkflowTemplatePublicPayloadSchema.safeParse({
      name: "Missing template id",
      tasks: [{ task_id: "task-1", title: "Task", owner_role: "developer" }]
    }).success,
    false
  );
});

test("workflow message schema routes nested to payload and requires content", () => {
  const message = WorkflowMessageSendRequestSchema.parse({
    content: "Please review",
    to: {
      role: "qa",
      session_id: "session-qa"
    },
    message_type: "TASK_DISCUSS_REQUEST"
  });
  assert.equal(message.fromAgent, "manager");
  assert.equal(message.fromSessionId, "manager-system");
  assert.equal(message.toRole, "qa");
  assert.equal(message.toSessionId, "session-qa");
  assert.equal(message.messageType, "TASK_DISCUSS_REQUEST");

  assert.equal(WorkflowMessageSendRequestSchema.safeParse({ content: "" }).success, false);
  assert.equal(WorkflowMessageSendPublicRequestSchema.safeParse({ message_type: "MANAGER_MESSAGE" }).success, false);
});

test("TeamTool error payload schema keeps structured errors bounded", () => {
  assert.equal(
    TeamToolErrorPayloadSchema.safeParse({
      error_code: "TASK_NOT_READY",
      message: "Dependency is not done",
      recoverable: true,
      next_action: "Wait for dependency"
    }).success,
    true
  );
  assert.equal(TeamToolErrorPayloadSchema.safeParse({ error_code: "TASK_NOT_READY" }).success, false);
});
