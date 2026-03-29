import assert from "node:assert/strict";
import test from "node:test";
import { executeOrchestratorMessageRouting } from "../services/orchestrator/shared/message-routing-template.js";

test("message routing template runs resolve -> normalize -> inbox -> route -> touch sequence", async () => {
  const order: string[] = [];
  const result = await executeOrchestratorMessageRouting(
    { runId: "run-1" },
    { content: "hello" },
    {
      resolveTarget: async () => {
        order.push("resolve");
        return { role: "dev", sessionId: "session-dev-1" };
      },
      normalizeEnvelope: async (_scope, target) => {
        order.push("normalize");
        return {
          messageId: "msg-1",
          resolvedSessionId: target.sessionId
        };
      },
      runInUnitOfWork: async (_scope, _input, operation) => {
        order.push("uow-begin");
        await operation();
        order.push("uow-end");
      },
      persistInbox: async () => {
        order.push("inbox");
      },
      persistRouteEvent: async () => {
        order.push("route");
      },
      touchSession: async () => {
        order.push("touch");
      },
      buildResult: async (_scope, target, envelope) => ({
        role: target.role,
        messageId: envelope.messageId
      })
    }
  );

  assert.deepEqual(order, ["resolve", "normalize", "uow-begin", "inbox", "route", "touch", "uow-end"]);
  assert.deepEqual(result, { role: "dev", messageId: "msg-1" });
});

test("message routing template propagates persistence errors", async () => {
  await assert.rejects(
    async () =>
      await executeOrchestratorMessageRouting(
        { runId: "run-2" },
        { content: "fail" },
        {
          resolveTarget: async () => ({ role: "dev", sessionId: "session-dev-2" }),
          normalizeEnvelope: async () => ({ messageId: "msg-2" }),
          persistInbox: async () => undefined,
          persistRouteEvent: async () => {
            throw new Error("route failed");
          },
          touchSession: async () => undefined,
          buildResult: async () => ({ ok: true })
        }
      ),
    /route failed/
  );
});
