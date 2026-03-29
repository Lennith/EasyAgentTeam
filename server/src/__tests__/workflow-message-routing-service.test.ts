import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkflowMessageRoutingService,
  buildWorkflowMessageReceivedPayload,
  buildWorkflowMessageRoutedPayload,
  buildWorkflowRoutedMessage
} from "../services/orchestrator/workflow-message-routing-service.js";

test("workflow message routing service routes to authoritative session and persists inbox plus events", async () => {
  const appendedInbox: Array<{ role: string; message: Record<string, unknown> }> = [];
  const touchedSessions: Array<{ sessionId: string; patch: Record<string, unknown> }> = [];
  const appendedEvents: Array<Record<string, unknown>> = [];

  const service = new WorkflowMessageRoutingService({
    repositories: {
      runInUnitOfWork: async (_scope: unknown, operation: () => Promise<unknown>) => await operation(),
      inbox: {
        appendInboxMessage: async (_runId: string, role: string, message: Record<string, unknown>) => {
          appendedInbox.push({ role, message });
        }
      },
      sessions: {
        listSessions: async () => [{ sessionId: "session-dev", role: "dev" }],
        getSession: async () => null,
        touchSession: async (_runId: string, sessionId: string, patch: Record<string, unknown>) => {
          touchedSessions.push({ sessionId, patch });
        }
      },
      events: {
        appendEvent: async (_runId: string, event: Record<string, unknown>) => {
          appendedEvents.push(event);
        }
      }
    } as any,
    loadRunOrThrow: async () =>
      ({
        runId: "run-1",
        routeTable: {
          manager: ["dev"]
        }
      }) as any,
    resolveAuthoritativeSession: async () => ({ sessionId: "session-dev", role: "dev" }) as any,
    createRuntimeError: (message: string) => new Error(message)
  });

  const result = await service.routeMessage({
    runId: "run-1",
    fromAgent: "manager",
    fromSessionId: "manager-system",
    messageType: "MANAGER_MESSAGE",
    toRole: "dev",
    taskId: "task-1",
    content: "please continue",
    requestId: "req-1"
  });

  assert.equal(result.requestId, "req-1");
  assert.equal(result.toRole, "dev");
  assert.equal(result.resolvedSessionId, "session-dev");
  assert.equal(appendedInbox.length, 1);
  assert.equal(appendedInbox[0]?.role, "dev");
  assert.equal((appendedInbox[0]?.message as any)?.envelope?.correlation?.request_id as string | undefined, "req-1");
  assert.equal((appendedInbox[0]?.message as any)?.envelope?.message_id as string | undefined, result.messageId);
  assert.equal((appendedInbox[0]?.message as any)?.body?.content as string | undefined, "please continue");
  assert.deepEqual(touchedSessions, [
    {
      sessionId: "session-dev",
      patch: {
        lastInboxMessageId: result.messageId
      }
    }
  ]);
  assert.deepEqual(appendedEvents, [
    {
      eventType: "USER_MESSAGE_RECEIVED",
      source: "manager",
      sessionId: "manager-system",
      taskId: "task-1",
      payload: buildWorkflowMessageReceivedPayload({
        fromAgent: "manager",
        toRole: "dev",
        requestId: "req-1",
        content: "please continue"
      })
    },
    {
      eventType: "MESSAGE_ROUTED",
      source: "manager",
      sessionId: "session-dev",
      taskId: "task-1",
      payload: buildWorkflowMessageRoutedPayload({
        fromAgent: "manager",
        toRole: "dev",
        resolvedSessionId: "session-dev",
        requestId: "req-1",
        messageId: result.messageId,
        content: "please continue",
        messageType: "MANAGER_MESSAGE",
        discuss: null
      })
    }
  ]);
});

test("workflow message routing service rejects route denied by workflow route table", async () => {
  const service = new WorkflowMessageRoutingService({
    repositories: {} as any,
    loadRunOrThrow: async () =>
      ({
        runId: "run-1",
        routeTable: {
          manager: ["qa"]
        }
      }) as any,
    resolveAuthoritativeSession: async () => null,
    createRuntimeError: (message: string) => new Error(message)
  });

  await assert.rejects(
    async () =>
      await service.routeMessage({
        runId: "run-1",
        fromAgent: "manager",
        fromSessionId: "manager-system",
        messageType: "MANAGER_MESSAGE",
        toRole: "dev",
        content: "blocked"
      }),
    /route not allowed by workflow route table/
  );
});

test("workflow routed message builder keeps discuss and accountability contract stable", () => {
  const message = buildWorkflowRoutedMessage({
    runId: "run-1",
    fromAgent: "manager",
    fromSessionId: "manager-system",
    messageType: "TASK_DISCUSS_REQUEST",
    resolvedRole: "dev",
    requestId: "req-1",
    messageId: "msg-1",
    createdAt: "2026-03-28T12:00:00.000Z",
    taskId: "task-1",
    content: "need a reply",
    parentRequestId: "parent-1",
    discuss: { threadId: "thread-1", requestId: "req-1" }
  });

  assert.deepEqual(message, {
    envelope: {
      message_id: "msg-1",
      run_id: "run-1",
      timestamp: "2026-03-28T12:00:00.000Z",
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
        report_to: { role: "manager", session_id: "manager-system" },
        expect: "DISCUSS_REPLY"
      },
      dispatch_policy: "fixed_session"
    },
    body: {
      messageType: "TASK_DISCUSS_REQUEST",
      mode: "CHAT",
      content: "need a reply",
      taskId: "task-1",
      discuss: { threadId: "thread-1", requestId: "req-1" }
    }
  });
});
