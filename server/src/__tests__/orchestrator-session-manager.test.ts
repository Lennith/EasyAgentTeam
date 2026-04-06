import assert from "node:assert/strict";
import test from "node:test";
import {
  hasOrchestratorSessionHeartbeatTimedOut,
  resolveLatestSessionActivityMs
} from "../services/orchestrator/shared/session-manager.js";

test("session manager resolves latest activity timestamp across candidates", () => {
  assert.equal(
    resolveLatestSessionActivityMs("2026-04-05T10:00:00.000Z", "2026-04-05T10:05:00.000Z", "2026-04-05T09:59:00.000Z"),
    Date.parse("2026-04-05T10:05:00.000Z")
  );
});

test("session manager heartbeat timeout uses latest known activity", () => {
  assert.equal(
    hasOrchestratorSessionHeartbeatTimedOut({
      lastActiveAt: "2026-04-05T10:05:00.000Z",
      updatedAt: "2026-04-05T10:04:00.000Z",
      createdAt: "2026-04-05T10:00:00.000Z",
      timeoutMs: 5 * 60 * 1000,
      nowMs: Date.parse("2026-04-05T10:10:00.000Z")
    }),
    true
  );
  assert.equal(
    hasOrchestratorSessionHeartbeatTimedOut({
      lastActiveAt: "2026-04-05T10:05:01.000Z",
      updatedAt: "2026-04-05T10:04:00.000Z",
      createdAt: "2026-04-05T10:00:00.000Z",
      timeoutMs: 5 * 60 * 1000,
      nowMs: Date.parse("2026-04-05T10:10:00.000Z")
    }),
    false
  );
});
