import type { ProviderId } from "@autodev/agent-library";
import type { ReminderMode } from "./project";

export interface WorkflowTemplateTaskRecord {
  taskId: string;
  title: string;
  ownerRole: string;
  parentTaskId?: string;
  dependencies?: string[];
  writeSet?: string[];
  acceptance?: string[];
  artifacts?: string[];
}

export interface WorkflowTemplateRecord {
  schemaVersion: "1.0";
  templateId: string;
  name: string;
  description?: string;
  tasks: WorkflowTemplateTaskRecord[];
  routeTable?: Record<string, string[]>;
  taskAssignRouteTable?: Record<string, string[]>;
  routeDiscussRounds?: Record<string, Record<string, number>>;
  defaultVariables?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunTaskRecord extends WorkflowTemplateTaskRecord {
  resolvedTitle: string;
  creatorRole?: string;
  creatorSessionId?: string;
}

export type WorkflowRunState = "created" | "running" | "stopped" | "finished" | "failed";
export type WorkflowRunMode = "none" | "loop" | "schedule";

export interface WorkflowRunSpawnState {
  isActive?: boolean;
  activeRunId?: string;
  lastWindowKey?: string;
  lastSpawnedRunId?: string;
  lastSpawnedAt?: string;
  lastTriggeredAt?: string;
  lastWindowStartAt?: string;
  lastWindowEndAt?: string;
  nextAvailableAt?: string;
}

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

export interface WorkflowRunRecord {
  schemaVersion: "2.0";
  runId: string;
  templateId: string;
  name: string;
  description?: string;
  workspacePath: string;
  routeTable?: Record<string, string[]>;
  taskAssignRouteTable?: Record<string, string[]>;
  routeDiscussRounds?: Record<string, Record<string, number>>;
  variables?: Record<string, string>;
  taskOverrides?: Record<string, string>;
  tasks: WorkflowRunTaskRecord[];
  status: WorkflowRunState;
  mode?: WorkflowRunMode;
  loopEnabled?: boolean;
  scheduleEnabled?: boolean;
  scheduleExpression?: string;
  isScheduleSeed?: boolean;
  originRunId?: string;
  lastSpawnedRunId?: string;
  spawnState?: WorkflowRunSpawnState;
  autoDispatchEnabled?: boolean;
  autoDispatchRemaining?: number;
  autoDispatchInitialRemaining?: number;
  holdEnabled?: boolean;
  reminderMode?: ReminderMode;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stoppedAt?: string;
  lastHeartbeatAt?: string;
  runtime?: {
    initializedAt: string;
    updatedAt: string;
    transitionSeq: number;
    tasks: WorkflowTaskRuntimeRecord[];
  };
}

export interface WorkflowRunOrchestratorSettings {
  run_id: string;
  mode: WorkflowRunMode;
  loop_enabled: boolean;
  schedule_enabled: boolean;
  schedule_expression?: string;
  is_schedule_seed: boolean;
  origin_run_id?: string;
  last_spawned_run_id?: string;
  spawn_state?: WorkflowRunSpawnState;
  auto_dispatch_enabled: boolean;
  auto_dispatch_remaining: number;
  auto_dispatch_initial_remaining: number;
  hold_enabled: boolean;
  reminder_mode: "backoff" | "fixed_interval";
  recurring_status: {
    occupied: boolean;
    active_run_id?: string;
    next_trigger_at?: string;
    last_triggered_at?: string;
  };
  updated_at: string;
}

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
  maxConcurrentDispatches?: number;
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

export interface WorkflowSessionRecord {
  schemaVersion: "1.0";
  sessionId: string;
  runId: string;
  role: string;
  provider: ProviderId;
  providerSessionId?: string | null;
  status: "running" | "idle" | "blocked" | "dismissed";
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  currentTaskId?: string;
  lastInboxMessageId?: string;
  lastDispatchedAt?: string;
  lastDispatchId?: string;
  lastDispatchedMessageId?: string;
}

export type WorkflowRunWorkspaceView = "overview" | "task-tree" | "chat" | "agent-chat" | "team-config" | "recovery";
export type WorkflowView = "runs" | "new-run" | "run-workspace" | "templates" | "new-template" | "edit-template";
