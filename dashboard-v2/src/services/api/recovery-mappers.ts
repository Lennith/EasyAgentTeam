import type {
  RuntimeRecoveryAttempt,
  RuntimeRecoveryAttemptPreview,
  RuntimeRecoveryAttemptsResponse,
  RuntimeRecoveryItem,
  RuntimeRecoveryResponse,
  RuntimeRecoverySummary
} from "@/types/recovery";

function mapRuntimeRecoveryItem(raw: Record<string, unknown>): RuntimeRecoveryItem {
  return {
    role: String(raw.role ?? ""),
    session_id: String(raw.session_id ?? ""),
    provider: String(raw.provider ?? ""),
    provider_session_id:
      raw.provider_session_id === null ? null : ((raw.provider_session_id as string | undefined) ?? null),
    status: raw.status as RuntimeRecoveryItem["status"],
    current_task_id: (raw.current_task_id as string | null | undefined) ?? null,
    current_task_title: (raw.current_task_title as string | null | undefined) ?? null,
    current_task_state: (raw.current_task_state as string | null | undefined) ?? null,
    role_session_mapping:
      (raw.role_session_mapping as RuntimeRecoveryItem["role_session_mapping"] | undefined) ?? "none",
    cooldown_until: (raw.cooldown_until as string | null | undefined) ?? null,
    last_failure_at: (raw.last_failure_at as string | null | undefined) ?? null,
    last_failure_kind: (raw.last_failure_kind as RuntimeRecoveryItem["last_failure_kind"] | undefined) ?? null,
    last_failure_event_id: (raw.last_failure_event_id as string | null | undefined) ?? null,
    last_failure_dispatch_id: (raw.last_failure_dispatch_id as string | null | undefined) ?? null,
    last_failure_message_id: (raw.last_failure_message_id as string | null | undefined) ?? null,
    last_failure_task_id: (raw.last_failure_task_id as string | null | undefined) ?? null,
    error_streak: Number(raw.error_streak ?? 0),
    timeout_streak: Number(raw.timeout_streak ?? 0),
    retryable: typeof raw.retryable === "boolean" ? raw.retryable : null,
    code: (raw.code as string | null | undefined) ?? null,
    message: (raw.message as string | null | undefined) ?? null,
    next_action: (raw.next_action as string | null | undefined) ?? null,
    raw_status: typeof raw.raw_status === "number" || typeof raw.raw_status === "string" ? raw.raw_status : null,
    last_event_type: (raw.last_event_type as string | null | undefined) ?? null,
    can_dismiss: Boolean(raw.can_dismiss),
    can_repair_to_idle: Boolean(raw.can_repair_to_idle),
    can_repair_to_blocked: Boolean(raw.can_repair_to_blocked),
    can_retry_dispatch: Boolean(raw.can_retry_dispatch),
    disabled_reason: (raw.disabled_reason as string | null | undefined) ?? null,
    risk: (raw.risk as string | null | undefined) ?? null,
    requires_confirmation: Boolean(raw.requires_confirmation),
    recovery_attempts: Array.isArray(raw.recovery_attempts)
      ? raw.recovery_attempts.map((attempt) => mapRuntimeRecoveryAttemptPreview(attempt as Record<string, unknown>))
      : []
  };
}

export function mapRuntimeRecoveryAttemptPreview(raw: Record<string, unknown>): RuntimeRecoveryAttemptPreview {
  return {
    recovery_attempt_id: String(raw.recovery_attempt_id ?? ""),
    status: (raw.status as RuntimeRecoveryAttemptPreview["status"] | undefined) ?? "requested",
    integrity: (raw.integrity as RuntimeRecoveryAttemptPreview["integrity"] | undefined) ?? "incomplete",
    missing_markers: Array.isArray(raw.missing_markers)
      ? raw.missing_markers
          .filter((marker): marker is string => typeof marker === "string")
          .map((marker) => marker as RuntimeRecoveryAttemptPreview["missing_markers"][number])
      : [],
    requested_at: (raw.requested_at as string | null | undefined) ?? null,
    last_event_at: String(raw.last_event_at ?? ""),
    ended_at: (raw.ended_at as string | null | undefined) ?? null,
    dispatch_scope: (raw.dispatch_scope as RuntimeRecoveryAttemptPreview["dispatch_scope"] | undefined) ?? null,
    current_task_id: (raw.current_task_id as string | null | undefined) ?? null
  };
}

export function mapRuntimeRecoveryAttempt(raw: Record<string, unknown>): RuntimeRecoveryAttempt {
  return {
    ...mapRuntimeRecoveryAttemptPreview(raw),
    events: Array.isArray(raw.events)
      ? raw.events.map((event) => ({
          event_type: String((event as Record<string, unknown>).event_type ?? ""),
          created_at: String((event as Record<string, unknown>).created_at ?? ""),
          payload_summary: String((event as Record<string, unknown>).payload_summary ?? "")
        }))
      : []
  };
}

function mapRuntimeRecoverySummary(raw: Record<string, unknown>): RuntimeRecoverySummary {
  return {
    all_sessions_total: Number(raw.all_sessions_total ?? 0),
    recovery_candidates_total: Number(raw.recovery_candidates_total ?? 0),
    running: Number(raw.running ?? 0),
    blocked: Number(raw.blocked ?? 0),
    idle: Number(raw.idle ?? 0),
    dismissed: Number(raw.dismissed ?? 0),
    cooling_down: Number(raw.cooling_down ?? 0),
    failed_recently: Number(raw.failed_recently ?? 0)
  };
}

export function mapRuntimeRecoveryResponse(raw: Record<string, unknown>): RuntimeRecoveryResponse {
  return {
    scope_kind: raw.scope_kind as RuntimeRecoveryResponse["scope_kind"],
    scope_id: String(raw.scope_id ?? ""),
    generated_at: String(raw.generated_at ?? ""),
    summary: mapRuntimeRecoverySummary((raw.summary ?? {}) as Record<string, unknown>),
    items: Array.isArray(raw.items)
      ? raw.items.map((item) => mapRuntimeRecoveryItem(item as Record<string, unknown>))
      : []
  };
}

export function mapRuntimeRecoveryAttemptsResponse(raw: Record<string, unknown>): RuntimeRecoveryAttemptsResponse {
  return {
    scope_kind: raw.scope_kind as RuntimeRecoveryAttemptsResponse["scope_kind"],
    scope_id: String(raw.scope_id ?? ""),
    session_id: String(raw.session_id ?? ""),
    generated_at: String(raw.generated_at ?? ""),
    attempt_limit:
      raw.attempt_limit === "all" ? "all" : Number.isFinite(Number(raw.attempt_limit)) ? Number(raw.attempt_limit) : 0,
    total_attempts: Number(raw.total_attempts ?? 0),
    truncated: Boolean(raw.truncated),
    recovery_attempts: Array.isArray(raw.recovery_attempts)
      ? raw.recovery_attempts.map((attempt) => mapRuntimeRecoveryAttempt(attempt as Record<string, unknown>))
      : []
  };
}

export function buildRetryDispatchGuardBody(
  item: RuntimeRecoveryItem,
  reason: string,
  confirm?: boolean
): Record<string, unknown> {
  return {
    reason,
    actor: "dashboard",
    expected_status: "idle",
    expected_role_mapping: item.role_session_mapping,
    ...(item.current_task_id ? { expected_current_task_id: item.current_task_id } : {}),
    ...(item.last_failure_at ? { expected_last_failure_at: item.last_failure_at } : {}),
    ...(item.last_failure_event_id ? { expected_last_failure_event_id: item.last_failure_event_id } : {}),
    ...(item.last_failure_dispatch_id ? { expected_last_failure_dispatch_id: item.last_failure_dispatch_id } : {}),
    ...(item.last_failure_message_id ? { expected_last_failure_message_id: item.last_failure_message_id } : {}),
    ...(item.last_failure_task_id ? { expected_last_failure_task_id: item.last_failure_task_id } : {}),
    ...(confirm ? { confirm: true } : {})
  };
}
