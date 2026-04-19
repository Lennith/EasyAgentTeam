import assert from "node:assert/strict";
import test from "node:test";
import { resolveRecoveryActions } from "../services/runtime-recovery-action-policy.js";

test("running session cannot repair to idle or blocked", () => {
  const policy = resolveRecoveryActions({
    scope_kind: "workflow",
    session_status: "running",
    current_task_id: "task_a",
    cooldown_until: null,
    last_failure_kind: "error",
    provider_session_id: "provider-1",
    role_session_mapping: "authoritative",
    process_state: "running"
  });

  assert.equal(policy.can_dismiss, true);
  assert.equal(policy.can_repair_to_idle, false);
  assert.equal(policy.can_repair_to_blocked, false);
  assert.equal(policy.disabled_reason, "Session is still running. Dismiss it before attempting repair.");
  assert.equal(
    policy.risk,
    "Current task 'task_a' is still attached to this session; review its context before repairing."
  );
});

test("idle session with cooldown does not expose repair or retry", () => {
  const policy = resolveRecoveryActions({
    scope_kind: "project",
    session_status: "idle",
    current_task_id: "task_b",
    cooldown_until: "2099-01-01T00:00:00.000Z",
    last_failure_kind: "error",
    provider_session_id: "provider-1",
    role_session_mapping: "authoritative",
    process_state: "not_running"
  });

  assert.equal(policy.can_dismiss, true);
  assert.equal(policy.can_repair_to_idle, false);
  assert.equal(policy.can_repair_to_blocked, false);
  assert.equal(policy.can_retry_dispatch, false);
  assert.equal(
    policy.disabled_reason,
    "Cooldown is still active. Wait for cooldown to expire before retrying or repairing this session."
  );
});

test("blocked session can repair to idle and returns current task risk", () => {
  const policy = resolveRecoveryActions({
    scope_kind: "workflow",
    session_status: "blocked",
    current_task_id: "task_c",
    cooldown_until: null,
    last_failure_kind: "error",
    provider_session_id: "provider-1",
    role_session_mapping: "authoritative",
    process_state: "not_running"
  });

  assert.equal(policy.can_dismiss, true);
  assert.equal(policy.can_repair_to_idle, true);
  assert.equal(policy.can_repair_to_blocked, false);
  assert.equal(
    policy.risk,
    "Current task 'task_c' is still attached to this session; review its context before repairing."
  );
});

test("dismissed session repair requires confirmation and marks manual recovery risk", () => {
  const policy = resolveRecoveryActions({
    scope_kind: "project",
    session_status: "dismissed",
    current_task_id: null,
    cooldown_until: null,
    last_failure_kind: "timeout",
    provider_session_id: null,
    role_session_mapping: "none",
    process_state: "not_running"
  });

  assert.equal(policy.can_dismiss, false);
  assert.equal(policy.can_repair_to_idle, true);
  assert.equal(policy.requires_confirmation, true);
  assert.equal(policy.risk, "Manual recovery may need to rebind this role before the session can run again.");
});
