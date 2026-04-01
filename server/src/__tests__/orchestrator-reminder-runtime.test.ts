import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOrchestratorReminderContent,
  buildOrchestratorReminderMessage,
  buildOrchestratorReminderOpenTaskSummary,
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

test("buildOrchestratorReminderOpenTaskSummary keeps ids, titles, and preview stable", () => {
  const summary = buildOrchestratorReminderOpenTaskSummary([
    { taskId: "task-a", title: "Task A" },
    { taskId: "task-b", title: "Task B" },
    { taskId: "task-c", title: "Task C" },
    { taskId: "task-d", title: "Task D" }
  ]);

  assert.deepEqual(summary.openTaskIds, ["task-a", "task-b", "task-c", "task-d"]);
  assert.deepEqual(summary.openTaskTitles, [
    { task_id: "task-a", title: "Task A" },
    { task_id: "task-b", title: "Task B" },
    { task_id: "task-c", title: "Task C" },
    { task_id: "task-d", title: "Task D" }
  ]);
  assert.equal(summary.openTaskTitlePreview, "task-a: Task A; task-b: Task B; task-c: Task C");
});

test("buildOrchestratorReminderContent includes preview prefix only when present", () => {
  const withPreview = buildOrchestratorReminderContent({
    openTaskCount: 2,
    openTaskTitlePreview: "task-a: Task A",
    instruction: "Please report progress."
  });
  const withoutPreview = buildOrchestratorReminderContent({
    openTaskCount: 1,
    openTaskTitlePreview: "",
    instruction: "Please report progress."
  });

  assert.equal(
    withPreview,
    "Reminder: you have 2 open task(s) without recent progress. Open tasks: task-a: Task A. Please report progress."
  );
  assert.equal(withoutPreview, "Reminder: you have 1 open task(s) without recent progress. Please report progress.");
});

test("buildOrchestratorReminderMessage builds project envelope/body with stable defaults", () => {
  const message = buildOrchestratorReminderMessage({
    scopeKind: "project",
    scopeId: "project-a",
    role: "dev",
    reminderMode: "backoff",
    reminderCount: 2,
    nextReminderAt: null,
    openTasks: [{ taskId: "task-a", title: "Task A" }],
    content: "Please report progress.",
    requestId: "req-a",
    messageId: "msg-a",
    primaryTaskId: "task-a"
  });

  assert.equal(message.envelope.project_id, "project-a");
  assert.equal(message.envelope.intent, "SYSTEM_NOTICE");
  assert.equal(message.envelope.correlation.request_id, "req-a");
  assert.equal(message.envelope.correlation.parent_request_id, undefined);
  const body = message.body as Record<string, unknown>;
  const reminder = body["reminder"] as { open_task_ids?: string[] } | undefined;
  assert.equal(body["messageType"], "MANAGER_MESSAGE");
  assert.equal(reminder?.open_task_ids?.[0], "task-a");
});

test("buildOrchestratorReminderMessage builds workflow envelope/body and defaults parentRequestId", () => {
  const message = buildOrchestratorReminderMessage({
    scopeKind: "workflow",
    scopeId: "run-a",
    role: "dev",
    reminderMode: "backoff",
    reminderCount: 1,
    nextReminderAt: "2026-03-29T00:01:00.000Z",
    openTasks: [{ taskId: "task-a", title: "Task A" }],
    content: "Please continue execution.",
    requestId: "req-wf",
    messageId: "msg-wf",
    primaryTaskId: "task-a"
  });

  assert.equal(message.envelope.run_id, "run-a");
  assert.equal(message.envelope.intent, "MANAGER_MESSAGE");
  assert.equal(message.envelope.correlation.request_id, "req-wf");
  assert.equal(message.envelope.correlation.parent_request_id, "req-wf");
  const body = message.body as Record<string, unknown>;
  const reminder = body["reminder"] as { open_task_ids?: string[] } | undefined;
  assert.equal(body["messageType"], "MANAGER_MESSAGE");
  assert.equal(reminder?.open_task_ids?.[0], "task-a");
});
