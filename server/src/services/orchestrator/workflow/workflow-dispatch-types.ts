export type WorkflowDispatchOutcome =
  | "dispatched"
  | "no_task"
  | "session_busy"
  | "run_not_running"
  | "invalid_target"
  | "already_dispatched";

export interface WorkflowDispatchRow {
  role: string;
  sessionId: string | null;
  taskId: string | null;
  dispatchKind?: "task" | "message" | null;
  messageId?: string;
  requestId?: string;
  outcome: WorkflowDispatchOutcome;
  reason?: string;
}

export interface WorkflowDispatchResult {
  runId: string;
  results: WorkflowDispatchRow[];
  dispatchedCount: number;
  remainingBudget: number;
}
