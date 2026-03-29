import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOrchestratorReminderRoleStatePatch,
  buildOrchestratorReminderSchedulePatch,
  buildOrchestratorReminderTriggeredPatch,
  evaluateOrchestratorReminderEligibility
} from "../services/orchestrator/shared/index.js";

const TIMING = {
  initialWaitMs: 60_000,
  backoffMultiplier: 2,
  maxWaitMs: 1_800_000
} as const;

test("buildOrchestratorReminderRoleStatePatch resets reminder state on INACTIVE -> IDLE", () => {
  const nowMs = Date.parse("2026-03-29T00:00:00.000Z");
  const patch = buildOrchestratorReminderRoleStatePatch({
    previousRoleState: "INACTIVE",
    currentRoleState: "IDLE",
    reminderMode: "backoff",
    reminderCount: 3,
    nowMs,
    idleSince: "2026-03-29T00:00:00.000Z",
    timing: TIMING
  });

  assert.equal(patch.lastRoleState, "IDLE");
  assert.equal(patch.reminderCount, 0);
  assert.equal(patch.idleSince, "2026-03-29T00:00:00.000Z");
  assert.equal(patch.nextReminderAt, new Date(nowMs + 60_000).toISOString());
});

test("buildOrchestratorReminderRoleStatePatch schedules reminder when role becomes idle", () => {
  const nowMs = Date.parse("2026-03-29T00:00:00.000Z");
  const patch = buildOrchestratorReminderRoleStatePatch({
    previousRoleState: "RUNNING",
    currentRoleState: "IDLE",
    reminderMode: "backoff",
    reminderCount: 2,
    nowMs,
    idleSince: "2026-03-29T00:00:00.000Z",
    timing: TIMING
  });

  assert.equal(patch.lastRoleState, "IDLE");
  assert.equal(patch.idleSince, "2026-03-29T00:00:00.000Z");
  assert.equal(patch.nextReminderAt, new Date(nowMs + 240_000).toISOString());
});

test("buildOrchestratorReminderRoleStatePatch keeps non-idle role state without reminder schedule", () => {
  const patch = buildOrchestratorReminderRoleStatePatch({
    previousRoleState: "IDLE",
    currentRoleState: "RUNNING",
    reminderMode: "backoff",
    reminderCount: 1,
    nowMs: Date.parse("2026-03-29T00:00:00.000Z"),
    timing: TIMING
  });

  assert.deepEqual(patch, {
    lastRoleState: "RUNNING"
  });
});

test("buildOrchestratorReminderSchedulePatch and buildOrchestratorReminderTriggeredPatch share schedule baseline", () => {
  const nowMs = Date.parse("2026-03-29T00:00:00.000Z");
  const schedulePatch = buildOrchestratorReminderSchedulePatch({
    reminderMode: "backoff",
    reminderCount: 1,
    nowMs,
    timing: TIMING
  });
  const triggeredPatch = buildOrchestratorReminderTriggeredPatch({
    reminderMode: "backoff",
    reminderCount: 1,
    nowMs,
    timing: TIMING
  });

  const expectedNextReminderAt = new Date(nowMs + 120_000).toISOString();
  assert.equal(schedulePatch.nextReminderAt, expectedNextReminderAt);
  assert.equal(schedulePatch.lastRoleState, "IDLE");
  assert.equal(triggeredPatch.nextReminderAt, expectedNextReminderAt);
  assert.equal(triggeredPatch.reminderCount, 2);
  assert.equal(triggeredPatch.lastRoleState, "IDLE");
});

test("evaluateOrchestratorReminderEligibility keeps trigger and schedule-missing decisions stable", () => {
  const nowMs = Date.parse("2026-03-29T00:00:00.000Z");
  const triggered = evaluateOrchestratorReminderEligibility({
    currentRoleState: "IDLE",
    hasIdleSession: true,
    hasOpenTask: true,
    reminderCount: 0,
    maxRetries: 3,
    idleSince: "2026-03-29T00:00:00.000Z",
    nextReminderAt: "2026-03-29T00:00:00.000Z",
    nowMs
  });
  const missingSchedule = evaluateOrchestratorReminderEligibility({
    currentRoleState: "IDLE",
    hasIdleSession: true,
    hasOpenTask: true,
    reminderCount: 0,
    maxRetries: 3,
    idleSince: "2026-03-29T00:00:00.000Z",
    nextReminderAt: undefined,
    nowMs
  });

  assert.deepEqual(triggered, { eligible: true, reason: "trigger" });
  assert.equal(missingSchedule.eligible, false);
  assert.equal(missingSchedule.reason, "schedule_missing_next_reminder");
});
