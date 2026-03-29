import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRoleScopedSessionId,
  createOpaqueIdentifier,
  createTimestampRequestId,
  createTimestampedIdentifier,
  sanitizeOrchestratorRoleToken
} from "../services/orchestrator/shared/orchestrator-identifiers.js";

test("orchestrator identifier helper sanitizes role token and builds scoped session ids", () => {
  assert.equal(sanitizeOrchestratorRoleToken(" dev role / qa "), "dev-role-qa");
  const sessionId = buildRoleScopedSessionId("dev role / qa");
  assert.match(sessionId, /^session-dev-role-qa-[a-f0-9]{12}$/);
});

test("orchestrator identifier helper preserves distinct opaque and timestamped ids", () => {
  const opaque = createOpaqueIdentifier();
  const requestId = createTimestampRequestId();
  const reminderId = createTimestampedIdentifier("reminder-", 6);

  assert.match(opaque, /^[a-f0-9-]{36}$/);
  assert.match(requestId, /^\d+$/);
  assert.match(reminderId, /^reminder-\d+-[a-f0-9]{6}$/);
});
