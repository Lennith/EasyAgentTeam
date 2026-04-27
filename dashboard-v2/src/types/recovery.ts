export interface RuntimeRecoveryEventSummary {
  event_type: string;
  created_at: string;
  payload_summary: string;
}

export interface RuntimeRecoveryAttemptPreview {
  recovery_attempt_id: string;
  status: "requested" | "accepted" | "running" | "finished" | "failed" | "rejected";
  integrity: "complete" | "incomplete";
  missing_markers: Array<"requested" | "accepted_or_rejected" | "dispatch_started" | "dispatch_terminal">;
  requested_at: string | null;
  last_event_at: string;
  ended_at: string | null;
  dispatch_scope: "task" | "role" | null;
  current_task_id: string | null;
}

export interface RuntimeRecoveryAttempt extends RuntimeRecoveryAttemptPreview {
  events: RuntimeRecoveryEventSummary[];
}

export interface RuntimeRecoveryItem {
  role: string;
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  status: "running" | "idle" | "blocked" | "dismissed";
  current_task_id: string | null;
  current_task_title: string | null;
  current_task_state: string | null;
  role_session_mapping: "authoritative" | "stale" | "none";
  cooldown_until: string | null;
  last_failure_at: string | null;
  last_failure_kind: "timeout" | "error" | null;
  last_failure_event_id: string | null;
  last_failure_dispatch_id: string | null;
  last_failure_message_id: string | null;
  last_failure_task_id: string | null;
  error_streak: number;
  timeout_streak: number;
  retryable: boolean | null;
  code: string | null;
  message: string | null;
  next_action: string | null;
  raw_status: number | string | null;
  last_event_type: string | null;
  can_dismiss: boolean;
  can_repair_to_idle: boolean;
  can_repair_to_blocked: boolean;
  can_retry_dispatch: boolean;
  disabled_reason: string | null;
  risk: string | null;
  requires_confirmation: boolean;
  latest_events: RuntimeRecoveryEventSummary[];
  recovery_attempts: RuntimeRecoveryAttemptPreview[];
}

export interface RuntimeRecoverySummary {
  all_sessions_total: number;
  recovery_candidates_total: number;
  running: number;
  blocked: number;
  idle: number;
  dismissed: number;
  cooling_down: number;
  failed_recently: number;
}

export interface RuntimeRecoveryResponse {
  scope_kind: "project" | "workflow";
  scope_id: string;
  generated_at: string;
  summary: RuntimeRecoverySummary;
  items: RuntimeRecoveryItem[];
}

export interface RuntimeRecoveryAttemptsResponse {
  scope_kind: "project" | "workflow";
  scope_id: string;
  session_id: string;
  generated_at: string;
  attempt_limit: number | "all";
  total_attempts: number;
  truncated: boolean;
  recovery_attempts: RuntimeRecoveryAttempt[];
}
