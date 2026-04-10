import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkflowScheduleWindowKey,
  computeNextWorkflowScheduleTriggerAt,
  matchesWorkflowSchedulePattern,
  parseWorkflowScheduleExpression,
  resolveWorkflowScheduleWindowRange
} from "../services/orchestrator/workflow/workflow-recurring-schedule.js";

test("workflow recurring schedule parser supports MM-DD HH:MM with XX matrix", () => {
  const validExpressions = ["XX-XX 09:00", "XX-XX 09:XX", "12-31 23:59", "01-01 00:00", "05-XX 18:30", "XX-21 08:15"];
  const invalidExpressions = [
    "",
    "XX-XX 24:00",
    "XX-XX 09:60",
    "13-01 09:00",
    "00-10 09:00",
    "XX-00 09:00",
    "XX-32 09:00",
    "XX-XX XX:00",
    "X-XX 09:00",
    "XX-XX0900"
  ];

  for (const expression of validExpressions) {
    assert.ok(parseWorkflowScheduleExpression(expression), `expected valid expression: ${expression}`);
  }
  for (const expression of invalidExpressions) {
    assert.equal(parseWorkflowScheduleExpression(expression), null, `expected invalid expression: ${expression}`);
  }
  assert.equal(validExpressions.length + invalidExpressions.length, 16);
});

test("workflow recurring schedule matcher handles wildcard and fixed windows", () => {
  const cases: Array<{
    expression: string;
    timestamp: string;
    expected: boolean;
  }> = [
    { expression: "XX-XX 09:00", timestamp: "2026-04-08T01:00:00.000Z", expected: true },
    { expression: "XX-XX 09:00", timestamp: "2026-04-08T01:01:00.000Z", expected: false },
    { expression: "XX-XX 09:XX", timestamp: "2026-04-08T01:33:00.000Z", expected: true },
    { expression: "XX-XX 09:XX", timestamp: "2026-04-08T02:00:00.000Z", expected: false },
    { expression: "04-08 09:00", timestamp: "2026-04-08T01:00:00.000Z", expected: true },
    { expression: "04-08 09:00", timestamp: "2026-04-09T01:00:00.000Z", expected: false },
    { expression: "04-XX 09:15", timestamp: "2026-04-21T01:15:00.000Z", expected: true },
    { expression: "04-21 09:15", timestamp: "2026-03-21T01:15:00.000Z", expected: false }
  ];

  for (const item of cases) {
    const parsed = parseWorkflowScheduleExpression(item.expression);
    assert.ok(parsed);
    assert.equal(matchesWorkflowSchedulePattern(parsed, new Date(item.timestamp)), item.expected);
  }
});

test("workflow recurring schedule window key and range honor HH:XX minute semantics", () => {
  const parsedWildcardMinute = parseWorkflowScheduleExpression("XX-XX 09:XX");
  assert.ok(parsedWildcardMinute);
  const nowInWindow = new Date("2026-04-08T01:21:00.000Z");
  const key = buildWorkflowScheduleWindowKey(parsedWildcardMinute, nowInWindow);
  assert.equal(key, "2026-04-08 09:21");
  const range = resolveWorkflowScheduleWindowRange(parsedWildcardMinute, nowInWindow);
  assert.ok(range);
  assert.equal(range.windowStartAt, "2026-04-08T01:00:00.000Z");
  assert.equal(range.windowEndAt, "2026-04-08T02:00:00.000Z");

  const parsedFixedMinute = parseWorkflowScheduleExpression("XX-XX 09:45");
  assert.ok(parsedFixedMinute);
  const fixedNow = new Date("2026-04-08T01:45:00.000Z");
  const fixedKey = buildWorkflowScheduleWindowKey(parsedFixedMinute, fixedNow);
  assert.equal(fixedKey, "2026-04-08 09:45");
  const fixedRange = resolveWorkflowScheduleWindowRange(parsedFixedMinute, fixedNow);
  assert.ok(fixedRange);
  assert.equal(fixedRange.windowStartAt, "2026-04-08T01:45:00.000Z");
  assert.equal(fixedRange.windowEndAt, "2026-04-08T01:46:00.000Z");
});

test("workflow recurring schedule next trigger search returns next minute-compatible match", () => {
  const minuteWildcard = parseWorkflowScheduleExpression("XX-XX 09:XX");
  assert.ok(minuteWildcard);
  const nextWildcard = computeNextWorkflowScheduleTriggerAt(minuteWildcard, new Date("2026-04-08T00:59:30.000Z"));
  assert.equal(nextWildcard, "2026-04-08T01:00:00.000Z");

  const fixedMinute = parseWorkflowScheduleExpression("XX-XX 09:05");
  assert.ok(fixedMinute);
  const nextFixed = computeNextWorkflowScheduleTriggerAt(fixedMinute, new Date("2026-04-08T01:05:10.000Z"));
  assert.equal(nextFixed, "2026-04-09T01:05:00.000Z");
});
