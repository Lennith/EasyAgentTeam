import assert from "node:assert/strict";
import { test } from "node:test";
import { isRemindableTaskState } from "../services/orchestrator-dispatch-core.js";

test("isRemindableTaskState aligns reminder candidates with actionable dispatch states", () => {
  assert.equal(isRemindableTaskState("READY"), true);
  assert.equal(isRemindableTaskState("DISPATCHED"), true);
  assert.equal(isRemindableTaskState("IN_PROGRESS"), true);
  assert.equal(isRemindableTaskState("MAY_BE_DONE"), true);

  assert.equal(isRemindableTaskState("PLANNED"), false);
  assert.equal(isRemindableTaskState("BLOCKED_DEP"), false);
  assert.equal(isRemindableTaskState("DONE"), false);
  assert.equal(isRemindableTaskState("CANCELED"), false);
  assert.equal(isRemindableTaskState(" ready "), true);
  assert.equal(isRemindableTaskState(undefined), false);
});
