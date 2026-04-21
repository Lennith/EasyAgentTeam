import assert from "node:assert/strict";
import test from "node:test";
import type { EventRecord, SessionStatus, TaskState } from "../domain/models.js";
import { resolveProjectSessionTimeoutEvidence } from "../services/orchestrator/project/project-session-timeout-evidence.js";

const BASE_TIME = "2026-04-21T10:00:00.000Z";
const BASE_MS = Date.parse(BASE_TIME);

function createInput(
  overrides: {
    session?: Partial<Parameters<typeof resolveProjectSessionTimeoutEvidence>[0]["session"]>;
    events?: EventRecord[];
    task?: { taskId: string; state: TaskState } | null;
    timeoutMs?: number;
    nowMs?: number;
  } = {}
) {
  return {
    session: {
      sessionId: "session-1",
      status: "running" as SessionStatus,
      currentTaskId: "task-1",
      lastActiveAt: "2026-04-21T09:59:40.000Z",
      updatedAt: "2026-04-21T09:59:40.000Z",
      createdAt: "2026-04-21T09:50:00.000Z",
      ...overrides.session
    },
    nowMs: overrides.nowMs ?? BASE_MS,
    timeoutMs: overrides.timeoutMs ?? 10_000,
    events: overrides.events ?? [],
    task: (overrides.task ?? { taskId: "task-1", state: "IN_PROGRESS" }) as Parameters<
      typeof resolveProjectSessionTimeoutEvidence
    >[0]["task"]
  };
}

test("project timeout evidence is protected by fresh heartbeat", () => {
  const decision = resolveProjectSessionTimeoutEvidence(
    createInput({
      session: { lastActiveAt: "2026-04-21T09:59:59.500Z" }
    })
  );

  assert.equal(decision.should_close, false);
  assert.equal(decision.protected_by_fresh_heartbeat, true);
  assert.equal(decision.protected_by_recent_terminal_report, false);
  assert.equal(decision.evidence_event_id, null);
  assert.equal(decision.decision_reason, "fresh_heartbeat");
});

test("project timeout evidence is protected by recent terminal report", () => {
  const decision = resolveProjectSessionTimeoutEvidence(
    createInput({
      session: {
        lastActiveAt: "2026-04-21T09:59:40.000Z"
      },
      task: { taskId: "task-1", state: "DONE" },
      events: [
        {
          schemaVersion: "1.0",
          eventId: "evt-terminal",
          projectId: "project-1",
          eventType: "TASK_REPORT_APPLIED",
          source: "manager",
          createdAt: "2026-04-21T09:59:58.000Z",
          sessionId: "session-1",
          taskId: "task-1",
          payload: {}
        }
      ]
    })
  );

  assert.equal(decision.should_close, false);
  assert.equal(decision.protected_by_fresh_heartbeat, false);
  assert.equal(decision.protected_by_recent_terminal_report, true);
  assert.equal(decision.evidence_event_id, "evt-terminal");
  assert.equal(decision.decision_reason, "recent_terminal_report");
});

test("project timeout evidence closes session without protection", () => {
  const decision = resolveProjectSessionTimeoutEvidence(
    createInput({
      session: {
        lastActiveAt: "2026-04-21T09:59:40.000Z"
      },
      events: []
    })
  );

  assert.equal(decision.should_close, true);
  assert.equal(decision.protected_by_fresh_heartbeat, false);
  assert.equal(decision.protected_by_recent_terminal_report, false);
  assert.equal(decision.evidence_event_id, null);
  assert.equal(decision.decision_reason, "heartbeat_timeout");
});
