import type { ReminderMode } from "./project-orchestrator";
import type { WorkflowRunMode, WorkflowRunSpawnState } from "./workflow-run";

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
