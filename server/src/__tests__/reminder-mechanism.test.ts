import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createProject } from "../data/project-store.js";
import {
  getRoleReminderState,
  readRoleRemindersState,
  updateRoleReminderState
} from "../data/role-reminder-store.js";
import {
  calculateNextReminderTime,
  shouldAutoResetReminderOnRoleTransition
} from "../services/orchestrator-service.js";

test("calculateNextReminderTime: default values produce 1 minute initial wait", () => {
  const nowMs = 1000000;
  const result = calculateNextReminderTime(0, nowMs);

  // Default initialWaitMs is 60000ms (1 minute)
  const expectedDate = new Date(nowMs + 60000);
  assert.equal(result, expectedDate.toISOString());
});

test("calculateNextReminderTime: second reminder uses 2x backoff", () => {
  const nowMs = 1000000;
  // reminderCount=1 means second reminder (0-based)
  // initialWaitMs * (2^1) = 60000 * 2 = 120000ms = 2 minutes
  const result = calculateNextReminderTime(1, nowMs);

  const expectedDate = new Date(nowMs + 120000);
  assert.equal(result, expectedDate.toISOString());
});

test("calculateNextReminderTime: third reminder uses 4x backoff", () => {
  const nowMs = 1000000;
  // reminderCount=2 means third reminder
  // initialWaitMs * (2^2) = 60000 * 4 = 240000ms = 4 minutes
  const result = calculateNextReminderTime(2, nowMs);

  const expectedDate = new Date(nowMs + 240000);
  assert.equal(result, expectedDate.toISOString());
});

test("calculateNextReminderTime: respects maxWaitMs cap", () => {
  const nowMs = 1000000;
  // Even with high reminderCount, should cap at maxWaitMs (default 30 min = 1800000ms)
  const result = calculateNextReminderTime(10, nowMs);

  const expectedDate = new Date(nowMs + 1800000);
  assert.equal(result, expectedDate.toISOString());
});

test("calculateNextReminderTime: custom options override defaults", () => {
  const nowMs = 1000000;
  const result = calculateNextReminderTime(0, nowMs, {
    initialWaitMs: 10000, // 10 seconds
    backoffMultiplier: 3,
    maxWaitMs: 900000 // 15 minutes
  });

  // 0: 10000ms = 10 seconds
  const expectedDate = new Date(nowMs + 10000);
  assert.equal(result, expectedDate.toISOString());
});

test("calculateNextReminderTime: custom backoff multiplier applies correctly", () => {
  const nowMs = 1000000;
  // With multiplier 3: 10000 * (3^2) = 10000 * 9 = 90000ms
  const result = calculateNextReminderTime(2, nowMs, {
    initialWaitMs: 10000,
    backoffMultiplier: 3,
    maxWaitMs: 900000
  });

  const expectedDate = new Date(nowMs + 90000);
  assert.equal(result, expectedDate.toISOString());
});

test("calculateNextReminderTime: custom maxWaitMs caps correctly", () => {
  const nowMs = 1000000;
  // With initialWaitMs=10000, multiplier=2, count=5: 10000*32=320000 > 90000, so caps at 90000
  const result = calculateNextReminderTime(5, nowMs, {
    initialWaitMs: 10000,
    backoffMultiplier: 2,
    maxWaitMs: 90000
  });

  const expectedDate = new Date(nowMs + 90000);
  assert.equal(result, expectedDate.toISOString());
});

test("shouldAutoResetReminderOnRoleTransition: only INACTIVE->IDLE resets", () => {
  assert.equal(shouldAutoResetReminderOnRoleTransition("INACTIVE", "IDLE"), true);
  assert.equal(shouldAutoResetReminderOnRoleTransition("RUNNING", "IDLE"), false);
  assert.equal(shouldAutoResetReminderOnRoleTransition("IDLE", "IDLE"), false);
  assert.equal(shouldAutoResetReminderOnRoleTransition("IDLE", "RUNNING"), false);
});

test("getRoleReminderState: returns null for non-existent role", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-reminder-test-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "remindertest",
    name: "Reminder Test",
    workspacePath: tempRoot
  });

  const result = await getRoleReminderState(created.paths, "remindertest", "nonexistent");
  assert.equal(result, null);
});

test("getRoleReminderState: returns existing reminder state for role", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-reminder-test-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "remindertest2",
    name: "Reminder Test 2",
    workspacePath: tempRoot
  });

  // First, update to create a reminder state
  await updateRoleReminderState(created.paths, "remindertest2", "dev", {
    reminderCount: 3,
    idleSince: "2024-01-01T00:00:00.000Z",
    nextReminderAt: "2024-01-01T00:05:00.000Z",
    lastRoleState: "IDLE"
  });

  const result = await getRoleReminderState(created.paths, "remindertest2", "dev");
  assert.notEqual(result, null);
  assert.equal(result?.role, "dev");
  assert.equal(result?.reminderCount, 3);
  assert.equal(result?.idleSince, "2024-01-01T00:00:00.000Z");
  assert.equal(result?.nextReminderAt, "2024-01-01T00:05:00.000Z");
  assert.equal(result?.lastRoleState, "IDLE");
});

test("updateRoleReminderState: creates new reminder state for new role", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-reminder-test-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "remindertest3",
    name: "Reminder Test 3",
    workspacePath: tempRoot
  });

  const result = await updateRoleReminderState(created.paths, "remindertest3", "tester", {
    reminderCount: 0,
    idleSince: "2024-01-01T00:00:00.000Z"
  });

  assert.equal(result.role, "tester");
  assert.equal(result.reminderCount, 0);
  assert.equal(result.idleSince, "2024-01-01T00:00:00.000Z");
});

test("updateRoleReminderState: updates existing reminder state", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-reminder-test-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "remindertest4",
    name: "Reminder Test 4",
    workspacePath: tempRoot
  });

  // Create initial state
  await updateRoleReminderState(created.paths, "remindertest4", "updater", {
    reminderCount: 0,
    idleSince: "2024-01-01T00:00:00.000Z"
  });

  // Update with new values
  const result = await updateRoleReminderState(created.paths, "remindertest4", "updater", {
    reminderCount: 5,
    nextReminderAt: "2024-01-01T00:10:00.000Z",
    lastRoleState: "RUNNING"
  });

  assert.equal(result.role, "updater");
  assert.equal(result.reminderCount, 5);
  assert.equal(result.idleSince, "2024-01-01T00:00:00.000Z"); // Preserved from original
  assert.equal(result.nextReminderAt, "2024-01-01T00:10:00.000Z");
  assert.equal(result.lastRoleState, "RUNNING");
});

test("readRoleRemindersState: returns default state for new project", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-reminder-test-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "remindertest5",
    name: "Reminder Test 5",
    workspacePath: tempRoot
  });

  const result = await readRoleRemindersState(created.paths, "remindertest5");

  assert.equal(result.schemaVersion, "1.0");
  assert.equal(result.projectId, "remindertest5");
  assert.ok(result.updatedAt);
  assert.deepEqual(result.roleReminders, []);
});

test("readRoleRemindersState: returns existing state with reminders", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-reminder-test-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "remindertest6",
    name: "Reminder Test 6",
    workspacePath: tempRoot
  });

  // Add multiple reminder states
  await updateRoleReminderState(created.paths, "remindertest6", "dev", { reminderCount: 1 });
  await updateRoleReminderState(created.paths, "remindertest6", "reviewer", { reminderCount: 2 });

  const result = await readRoleRemindersState(created.paths, "remindertest6");

  assert.equal(result.roleReminders.length, 2);
  const roles = result.roleReminders.map(r => r.role);
  assert.ok(roles.includes("dev"));
  assert.ok(roles.includes("reviewer"));
});

test("role reminder state is normalized (trimmed)", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-reminder-test-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "remindertest7",
    name: "Reminder Test 7",
    workspacePath: tempRoot
  });

  // Role with leading/trailing spaces
  await updateRoleReminderState(created.paths, "remindertest7", "  dev_role  ", { reminderCount: 0 });

  const result = await getRoleReminderState(created.paths, "remindertest7", "dev_role");
  assert.notEqual(result, null);
  assert.equal(result?.role, "dev_role");
});
