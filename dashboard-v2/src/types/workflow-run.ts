import type { ReminderMode } from "./project-orchestrator";
import type { WorkflowTaskRuntimeRecord } from "./workflow-task";
import type { WorkflowTemplateTaskRecord } from "./workflow-template";

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

export interface WorkflowRunRuntimeStatus {
  runId: string;
  status: WorkflowRunState;
  active: boolean;
  startedAt?: string;
  stoppedAt?: string;
  lastHeartbeatAt?: string;
}
