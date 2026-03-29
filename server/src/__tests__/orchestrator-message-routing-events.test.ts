import assert from "node:assert/strict";
import test from "node:test";
import { appendOrchestratorMessageRouteEventPair } from "../services/orchestrator/shared/message-routing-events.js";

test("message route event pair appends received then routed", async () => {
  const appended: string[] = [];
  await appendOrchestratorMessageRouteEventPair(
    async (event: { id: string }) => {
      appended.push(event.id);
    },
    {
      received: { id: "received" },
      routed: { id: "routed" }
    }
  );

  assert.deepEqual(appended, ["received", "routed"]);
});
