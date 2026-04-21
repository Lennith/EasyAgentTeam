import type { EventRecord, SessionRecord, TaskRecord } from "../../../domain/models.js";
import { hasOrchestratorSessionHeartbeatTimedOut, parseIsoMs } from "../shared/session-manager.js";

const TERMINAL_PROTECTION_TASK_STATES = new Set(["DONE", "BLOCKED_DEP", "CANCELED"]);
const TERMINAL_REPORT_TOOL_NAMES = new Set(["task_report_done", "task_report_block"]);
const MAX_TERMINAL_REPORT_PROTECTION_MS = 15_000;

export interface ProjectSessionTimeoutEvidenceInput {
  session: Pick<SessionRecord, "sessionId" | "status" | "currentTaskId" | "lastActiveAt" | "updatedAt" | "createdAt">;
  nowMs: number;
  timeoutMs: number;
  events: EventRecord[];
  task: Pick<TaskRecord, "taskId" | "state"> | null;
}

export interface ProjectSessionTimeoutEvidenceDecision {
  should_close: boolean;
  protected_by_fresh_heartbeat: boolean;
  protected_by_recent_terminal_report: boolean;
  evidence_event_id: string | null;
  decision_reason: "session_not_running" | "fresh_heartbeat" | "recent_terminal_report" | "heartbeat_timeout";
}

function resolveTerminalProtectionWindowMs(timeoutMs: number): number {
  return Math.max(250, Math.min(MAX_TERMINAL_REPORT_PROTECTION_MS, Math.floor(timeoutMs / 2)));
}

function findRecentTerminalReportEvent(input: ProjectSessionTimeoutEvidenceInput): EventRecord | null {
  const taskId = input.session.currentTaskId;
  const taskState = input.task?.state;
  if (!taskId || !taskState || !TERMINAL_PROTECTION_TASK_STATES.has(taskState)) {
    return null;
  }

  const protectionWindowMs = resolveTerminalProtectionWindowMs(input.timeoutMs);
  const recentEvents = [...input.events]
    .filter((event) => event.sessionId === input.session.sessionId && event.taskId === taskId)
    .sort((left, right) => parseIsoMs(right.createdAt) - parseIsoMs(left.createdAt));

  for (const event of recentEvents) {
    const ageMs = input.nowMs - parseIsoMs(event.createdAt);
    if (ageMs < 0 || ageMs > protectionWindowMs) {
      continue;
    }
    if (event.eventType === "TASK_REPORT_APPLIED") {
      return event;
    }
    if (event.eventType !== "TEAM_TOOL_SUCCEEDED") {
      continue;
    }
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const toolName = typeof payload.tool === "string" ? payload.tool : "";
    if (TERMINAL_REPORT_TOOL_NAMES.has(toolName)) {
      return event;
    }
  }

  return null;
}

export function resolveProjectSessionTimeoutEvidence(
  input: ProjectSessionTimeoutEvidenceInput
): ProjectSessionTimeoutEvidenceDecision {
  if (input.session.status !== "running") {
    return {
      should_close: false,
      protected_by_fresh_heartbeat: false,
      protected_by_recent_terminal_report: false,
      evidence_event_id: null,
      decision_reason: "session_not_running"
    };
  }

  const timedOut = hasOrchestratorSessionHeartbeatTimedOut({
    lastActiveAt: input.session.lastActiveAt,
    updatedAt: input.session.updatedAt,
    createdAt: input.session.createdAt,
    timeoutMs: input.timeoutMs,
    nowMs: input.nowMs
  });
  if (!timedOut) {
    return {
      should_close: false,
      protected_by_fresh_heartbeat: true,
      protected_by_recent_terminal_report: false,
      evidence_event_id: null,
      decision_reason: "fresh_heartbeat"
    };
  }

  const recentTerminalReport = findRecentTerminalReportEvent(input);
  if (recentTerminalReport) {
    return {
      should_close: false,
      protected_by_fresh_heartbeat: false,
      protected_by_recent_terminal_report: true,
      evidence_event_id: recentTerminalReport.eventId,
      decision_reason: "recent_terminal_report"
    };
  }

  return {
    should_close: true,
    protected_by_fresh_heartbeat: false,
    protected_by_recent_terminal_report: false,
    evidence_event_id: null,
    decision_reason: "heartbeat_timeout"
  };
}
