import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRecoveryPolicyContext,
  buildRecoveryPolicyInput,
  resolveRecoveryMappingState,
  resolveRecoveryProcessState
} from "../services/runtime-recovery-policy-context.js";

test("resolveRecoveryMappingState distinguishes authoritative, stale, and none", () => {
  assert.equal(resolveRecoveryMappingState({ lead: "session-a" }, "lead", "session-a"), "authoritative");
  assert.equal(resolveRecoveryMappingState({ lead: "session-a" }, "lead", "session-b"), "stale");
  assert.equal(resolveRecoveryMappingState(undefined, "lead", "session-a"), "none");
});

test("resolveRecoveryProcessState derives running and not_running from session status and pid", () => {
  assert.equal(resolveRecoveryProcessState("running", null), "running");
  assert.equal(resolveRecoveryProcessState("idle", 12345), "unknown");
  assert.equal(resolveRecoveryProcessState("blocked", null), "not_running");
});

test("buildRecoveryPolicyInput uses shared context defaults", () => {
  const input = buildRecoveryPolicyInput({
    scope_kind: "project",
    session: {
      role: "dev",
      sessionId: "session-dev",
      status: "idle",
      currentTaskId: "task-dev",
      cooldownUntil: "2099-01-01T00:00:00.000Z",
      lastFailureKind: "error",
      providerSessionId: "provider-dev",
      agentPid: 1234
    },
    role_session_map: { dev: "session-dev" }
  });

  assert.deepEqual(input, {
    scope_kind: "project",
    session_status: "idle",
    current_task_id: "task-dev",
    cooldown_until: "2099-01-01T00:00:00.000Z",
    last_failure_kind: "error",
    last_failure_event_id: null,
    last_failure_dispatch_id: null,
    last_failure_message_id: null,
    last_failure_task_id: null,
    provider_session_id: "provider-dev",
    role_session_mapping: "authoritative",
    process_state: "unknown"
  });
});

test("buildRecoveryPolicyContext keeps read model and command enforcement aligned", () => {
  const context = buildRecoveryPolicyContext({
    scope_kind: "workflow",
    session: {
      role: "lead",
      sessionId: "session-lead",
      status: "dismissed",
      currentTaskId: "task-a",
      cooldownUntil: null,
      lastFailureKind: "timeout",
      providerSessionId: null
    },
    role_session_map: {}
  });

  assert.equal(context.input.session_status, "dismissed");
  assert.equal(context.input.role_session_mapping, "none");
  assert.equal(context.policy.can_repair_to_idle, true);
  assert.equal(context.policy.requires_confirmation, true);
  assert.match(context.policy.risk ?? "", /Manual recovery/);
  assert.match(context.policy.risk ?? "", /task-a/);
});

test("buildRecoveryPolicyContext blocks recovery commands when agent pid leaves process state unknown", () => {
  const context = buildRecoveryPolicyContext({
    scope_kind: "project",
    session: {
      role: "dev",
      sessionId: "session-dev",
      status: "idle",
      currentTaskId: "task-dev",
      cooldownUntil: null,
      lastFailureKind: "error",
      providerSessionId: "provider-dev",
      agentPid: 1234
    },
    role_session_map: { dev: "session-dev" }
  });

  assert.equal(context.input.process_state, "unknown");
  assert.equal(context.policy.can_dismiss, true);
  assert.equal(context.policy.can_repair_to_idle, false);
  assert.equal(context.policy.can_retry_dispatch, false);
  assert.match(context.policy.disabled_reason ?? "", /Local process state is unknown/);
});
