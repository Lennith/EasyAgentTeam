import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowRunEventRecord, WorkflowSessionStatus, WorkflowTaskState } from "../domain/models.js";
import { resolveWorkflowSessionTimeoutEvidence } from "../services/orchestrator/workflow/workflow-session-timeout-evidence.js";

const BASE_TIME = "2026-04-21T10:00:00.000Z";
const BASE_MS = Date.parse(BASE_TIME);

function createInput(
  overrides: {
    session?: Partial<Parameters<typeof resolveWorkflowSessionTimeoutEvidence>[0]["session"]>;
    events?: WorkflowRunEventRecord[];
    task?: { taskId: string; state: WorkflowTaskState } | null;
    timeoutMs?: number;
    nowMs?: number;
  } = {}
) {
  return {
    session: {
      sessionId: "session-1",
      status: "running" as WorkflowSessionStatus,
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
      typeof resolveWorkflowSessionTimeoutEvidence
    >[0]["task"]
  };
}

test("workflow timeout evidence is protected by fresh heartbeat", () => {
  const decision = resolveWorkflowSessionTimeoutEvidence(
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

test("workflow timeout evidence is protected by recent terminal report", () => {
  const decision = resolveWorkflowSessionTimeoutEvidence(
    createInput({
      session: {
        lastActiveAt: "2026-04-21T09:59:40.000Z"
      },
      task: { taskId: "task-1", state: "BLOCKED_DEP" },
      events: [
        {
          schemaVersion: "1.0",
          eventId: "evt-terminal",
          runId: "run-1",
          eventType: "TEAM_TOOL_SUCCEEDED",
          source: "system",
          createdAt: "2026-04-21T09:59:58.000Z",
          sessionId: "session-1",
          taskId: "task-1",
          payload: { tool: "task_report_block" }
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

test("workflow timeout evidence closes session without protection", () => {
  const decision = resolveWorkflowSessionTimeoutEvidence(
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
