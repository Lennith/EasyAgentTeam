export type ReminderMode = "backoff" | "fixed_interval";

export interface OrchestratorSettings {
  project_id: string;
  auto_dispatch_enabled: boolean;
  auto_dispatch_remaining: number;
  hold_enabled?: boolean;
  reminder_mode?: ReminderMode;
  updated_at: string;
}

export interface OrchestratorStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  totalDispatches: number;
  pendingMessages: number;
  dispatchedMessages: number;
  failedDispatches: number;
  lastTick: string;
}

export interface DispatchResult {
  sessionId: string;
  role?: string;
  outcome?: string;
  dispatchKind?: string;
  messageId?: string;
  requestId?: string;
  runId?: string;
  taskId?: string;
  exitCode?: number;
  timedOut?: boolean;
  error?: string;
  dispatched?: boolean;
  reason?: string;
}
