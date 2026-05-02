import type { WorkflowRunState } from "./workflow-run";
import type { WorkflowRunTaskRecord } from "./workflow-run";

export type WorkflowTaskState =
  | "PLANNED"
  | "READY"
  | "DISPATCHED"
  | "IN_PROGRESS"
  | "BLOCKED_DEP"
  | "DONE"
  | "CANCELED";

export type WorkflowTaskOutcome = "IN_PROGRESS" | "BLOCKED_DEP" | "DONE" | "CANCELED";

export type WorkflowBlockReasonCode =
  | "DEP_UNSATISFIED"
  | "RUN_NOT_RUNNING"
  | "INVALID_TRANSITION"
  | "TASK_NOT_FOUND"
  | "TASK_ALREADY_TERMINAL";

export interface WorkflowTaskBlockReason {
  code: WorkflowBlockReasonCode;
  dependencyTaskIds?: string[];
  message?: string;
}

export interface WorkflowTaskTransitionRecord {
  seq: number;
  at: string;
  fromState: WorkflowTaskState | null;
  toState: WorkflowTaskState;
  reasonCode?: WorkflowBlockReasonCode;
  summary?: string;
}

export interface WorkflowTaskRuntimeRecord {
  taskId: string;
  state: WorkflowTaskState;
  blockedBy: string[];
  blockedReasons: WorkflowTaskBlockReason[];
  lastSummary?: string;
  blockers?: string[];
  lastTransitionAt: string;
  transitionCount: number;
  transitions: WorkflowTaskTransitionRecord[];
}

export interface WorkflowRunRuntimeCounters {
  total: number;
  planned: number;
  ready: number;
  dispatched: number;
  blocked: number;
  inProgress: number;
  done: number;
  canceled: number;
}

export interface WorkflowRunRuntimeSnapshot {
  runId: string;
  status: WorkflowRunState;
  active: boolean;
  updatedAt: string;
  counters: WorkflowRunRuntimeCounters;
  tasks: WorkflowTaskRuntimeRecord[];
}

export interface WorkflowTaskTreeRuntimeNode extends WorkflowRunTaskRecord {
  runtime: WorkflowTaskRuntimeRecord | null;
}

export interface WorkflowTaskTreeRuntimeEdge {
  from_task_id: string;
  to_task_id: string;
  relation: "PARENT_CHILD" | "DEPENDS_ON";
}

export interface WorkflowTaskTreeRuntimeResponse {
  run_id: string;
  generated_at: string;
  status: WorkflowRunState;
  active: boolean;
  roots: string[];
  nodes: WorkflowTaskTreeRuntimeNode[];
  edges: WorkflowTaskTreeRuntimeEdge[];
  counters: WorkflowRunRuntimeCounters;
}

export type WorkflowTaskActionType =
  | "TASK_CREATE"
  | "TASK_DISCUSS_REQUEST"
  | "TASK_DISCUSS_REPLY"
  | "TASK_DISCUSS_CLOSED"
  | "TASK_REPORT";

export interface WorkflowTaskActionRequest {
  action_type: WorkflowTaskActionType;
  from_agent?: string;
  from_session_id?: string;
  to_role?: string;
  to_session_id?: string;
  task_id?: string;
  content?: string;
  task?: {
    task_id: string;
    title: string;
    owner_role: string;
    parent_task_id?: string;
    dependencies?: string[];
    acceptance?: string[];
    artifacts?: string[];
  };
  discuss?: {
    thread_id?: string;
    request_id?: string;
  };
  results?: Array<{
    task_id: string;
    outcome: WorkflowTaskOutcome;
    summary?: string;
    blockers?: string[];
  }>;
}

export interface WorkflowTaskActionResult {
  success: boolean;
  requestId: string;
  actionType: WorkflowTaskActionType;
  createdTaskId?: string;
  messageId?: string;
  partialApplied: boolean;
  appliedTaskIds: string[];
  rejectedResults: Array<{
    taskId: string;
    reasonCode: WorkflowBlockReasonCode;
    reason: string;
  }>;
  snapshot: WorkflowRunRuntimeSnapshot;
}
