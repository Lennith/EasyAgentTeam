import assert from "node:assert/strict";
import test from "node:test";
import { resolveRunnerFailureTransition } from "../services/orchestrator/shared/runner-failure-transition.js";

test("runner failure transition resolves transient provider errors to idle cooldown with snake_case payload", () => {
  const result = resolveRunnerFailureTransition({
    kind: "transient",
    now: "2026-04-19T02:00:00.000Z",
    run_id: "run-1",
    dispatch_id: "dispatch-1",
    dispatch_kind: "task",
    message_id: null,
    error: "MiniMax upstream returned transient status 529.",
    code: "PROVIDER_UPSTREAM_TRANSIENT_ERROR",
    next_action: "Wait for cooldown and retry the same task/message dispatch.",
    raw_status: 529,
    current_task_id: "task-1",
    preserve_current_task_id: true,
    existing_error_streak: 1,
    transient_cooldown_ms: 30000
  });

  assert.equal(result.session_status, "idle");
  assert.equal(result.retryable, true);
  assert.equal(result.event_type, "RUNNER_TRANSIENT_ERROR_SOFT");
  assert.equal(result.cooldown_until, "2026-04-19T02:00:30.000Z");
  assert.deepEqual(result.event_payload, {
    run_id: "run-1",
    dispatch_id: "dispatch-1",
    dispatch_kind: "task",
    message_id: null,
    error: "MiniMax upstream returned transient status 529.",
    code: "PROVIDER_UPSTREAM_TRANSIENT_ERROR",
    retryable: true,
    next_action: "Wait for cooldown and retry the same task/message dispatch.",
    raw_status: 529,
    cooldown_until: "2026-04-19T02:00:30.000Z"
  });
});

test("runner failure transition escalates timeout with snake_case payload", () => {
  const result = resolveRunnerFailureTransition({
    kind: "timeout",
    now: "2026-04-19T02:00:00.000Z",
    run_id: "run-2",
    dispatch_id: "dispatch-2",
    dispatch_kind: "message",
    message_id: "msg-1",
    current_task_id: "task-2",
    preserve_current_task_id: true,
    existing_timeout_streak: 1,
    timeout_threshold: 2,
    timeout_cooldown_ms: 10000
  });

  assert.equal(result.session_status, "dismissed");
  assert.equal(result.escalated, true);
  assert.equal(result.event_type, "RUNNER_TIMEOUT_ESCALATED");
  assert.deepEqual(result.event_payload, {
    run_id: "run-2",
    dispatch_id: "dispatch-2",
    dispatch_kind: "message",
    message_id: "msg-1",
    timeout_streak: 2,
    threshold: 2,
    cooldown_until: null
  });
});

test("runner failure transition keeps config errors blocked and structured", () => {
  const result = resolveRunnerFailureTransition({
    kind: "config",
    now: "2026-04-19T02:00:00.000Z",
    run_id: "run-3",
    dispatch_id: "dispatch-3",
    dispatch_kind: "task",
    error: "codex model mismatch",
    code: "PROVIDER_MODEL_MISMATCH",
    next_action: "Use a Codex model or switch provider.",
    raw_status: null,
    existing_error_streak: 0
  });

  assert.equal(result.session_status, "blocked");
  assert.equal(result.retryable, false);
  assert.equal(result.event_type, "RUNNER_CONFIG_ERROR_BLOCKED");
  assert.deepEqual(result.event_payload, {
    run_id: "run-3",
    dispatch_id: "dispatch-3",
    dispatch_kind: "task",
    message_id: null,
    error: "codex model mismatch",
    code: "PROVIDER_MODEL_MISMATCH",
    retryable: false,
    next_action: "Use a Codex model or switch provider.",
    raw_status: null
  });
});
