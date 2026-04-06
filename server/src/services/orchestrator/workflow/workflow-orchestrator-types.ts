import type {
  ReminderMode,
  WorkflowRunRuntimeSnapshot,
  WorkflowRunState,
  WorkflowTaskRuntimeRecord
} from "../../../domain/models.js";
export type {
  WorkflowDispatchOutcome,
  WorkflowDispatchResult,
  WorkflowDispatchRow
} from "./workflow-dispatch-types.js";

export interface WorkflowRunRuntimeStatus {
  runId: string;
  status: WorkflowRunState;
  active: boolean;
  startedAt?: string;
  stoppedAt?: string;
  lastHeartbeatAt?: string;
}

export interface WorkflowOrchestratorStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  maxConcurrentDispatches: number;
  inFlightDispatchSessions: number;
  lastTickAt: string | null;
  started: boolean;
  activeRunIds: string[];
  activeRunCount: number;
  runs?: Array<{
    runId: string;
    autoDispatchEnabled: boolean;
    autoDispatchRemaining: number;
    holdEnabled: boolean;
    reminderMode: ReminderMode;
  }>;
}

export interface WorkflowTaskTreeRuntimeResponse {
  run_id: string;
  generated_at: string;
  status: WorkflowRunState;
  active: boolean;
  roots: string[];
  nodes: Array<{
    taskId: string;
    title: string;
    resolvedTitle: string;
    ownerRole: string;
    parentTaskId?: string;
    dependencies?: string[];
    writeSet?: string[];
    acceptance?: string[];
    artifacts?: string[];
    creatorRole?: string;
    creatorSessionId?: string;
    runtime: WorkflowTaskRuntimeRecord | null;
  }>;
  edges: Array<{ from_task_id: string; to_task_id: string; relation: "PARENT_CHILD" | "DEPENDS_ON" }>;
  counters: WorkflowRunRuntimeSnapshot["counters"];
}

export interface WorkflowRunOrchestratorSettings {
  run_id: string;
  auto_dispatch_enabled: boolean;
  auto_dispatch_remaining: number;
  hold_enabled: boolean;
  reminder_mode: ReminderMode;
  updated_at: string;
}
