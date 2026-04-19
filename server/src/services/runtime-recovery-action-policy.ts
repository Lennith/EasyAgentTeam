export type RecoveryScopeKind = "project" | "workflow";
export type RecoveryStatus = "running" | "idle" | "blocked" | "dismissed";
export type RecoveryFailureKind = "timeout" | "error";
export type RecoveryProcessState = "running" | "not_running" | "unknown";
export type RecoveryMappingState = "authoritative" | "stale" | "none";
export type RecoveryRisk = "current_task_attached" | "manual_recovery" | "provider_binding_present" | "cooldown_active";

export interface ResolveRecoveryActionsInput {
  scope_kind: RecoveryScopeKind;
  session_status: RecoveryStatus;
  current_task_id?: string | null;
  cooldown_until?: string | null;
  last_failure_kind?: RecoveryFailureKind | null;
  provider_session_id?: string | null;
  role_session_mapping?: RecoveryMappingState;
  process_state?: RecoveryProcessState;
}

export interface RecoveryActionPolicy {
  can_dismiss: boolean;
  can_repair_to_idle: boolean;
  can_repair_to_blocked: boolean;
  can_retry_dispatch: boolean;
  disabled_reason: string | null;
  risk: string | null;
  requires_confirmation: boolean;
}

export interface RecoveryActionRejection {
  code: "SESSION_RECOVERY_ACTION_NOT_ALLOWED";
  message: string;
  next_action: string;
  disabled_reason: string | null;
  risk: string | null;
  details: Record<string, unknown>;
}

export type RecoveryProviderCancelResultCode = "cancelled" | "not_found" | "not_supported" | "failed" | "unknown";

export interface RecoveryProviderCancelResult {
  attempted: boolean;
  confirmed: boolean;
  result: RecoveryProviderCancelResultCode;
  error: string | null;
}

export interface RecoveryProcessTerminationView {
  attempted: boolean;
  result: string;
  message: string | null;
}

export interface RecoveryDismissResult<TSession> {
  action: "dismiss";
  session: TSession;
  previous_status: RecoveryStatus;
  next_status: "dismissed";
  provider_cancel: RecoveryProviderCancelResult;
  process_termination: RecoveryProcessTerminationView | null;
  mapping_cleared: boolean;
  warnings: string[];
}

export interface RecoveryRepairResult<TSession> {
  action: "repair";
  session: TSession;
  previous_status: RecoveryStatus;
  next_status: "idle" | "blocked";
  warnings: string[];
}

function isCooldownActive(cooldownUntil: string | null | undefined): boolean {
  if (!cooldownUntil) {
    return false;
  }
  const ts = Date.parse(cooldownUntil);
  return Number.isFinite(ts) && ts > Date.now();
}

function buildCurrentTaskRisk(taskId: string | null | undefined): string | null {
  if (!taskId) {
    return null;
  }
  return `Current task '${taskId}' is still attached to this session; review its context before repairing.`;
}

export function resolveRecoveryActions(input: ResolveRecoveryActionsInput): RecoveryActionPolicy {
  const currentTaskRisk = buildCurrentTaskRisk(input.current_task_id ?? null);
  const coolingDown = isCooldownActive(input.cooldown_until ?? null);
  const hasProviderBinding = Boolean(input.provider_session_id);

  if (input.session_status === "running" || input.process_state === "running") {
    return {
      can_dismiss: true,
      can_repair_to_idle: false,
      can_repair_to_blocked: false,
      can_retry_dispatch: false,
      disabled_reason: "Session is still running. Dismiss it before attempting repair.",
      risk: currentTaskRisk,
      requires_confirmation: false
    };
  }

  if (input.session_status === "blocked") {
    return {
      can_dismiss: true,
      can_repair_to_idle: true,
      can_repair_to_blocked: false,
      can_retry_dispatch: false,
      disabled_reason: null,
      risk: currentTaskRisk,
      requires_confirmation: false
    };
  }

  if (input.session_status === "dismissed") {
    const bindingRisk =
      input.role_session_mapping === "none"
        ? "Manual recovery may need to rebind this role before the session can run again."
        : null;
    return {
      can_dismiss: false,
      can_repair_to_idle: true,
      can_repair_to_blocked: false,
      can_retry_dispatch: false,
      disabled_reason: "Session is already dismissed.",
      risk: bindingRisk ?? currentTaskRisk ?? "Manual recovery should be used only when the role is ready to resume.",
      requires_confirmation: true
    };
  }

  if (input.session_status === "idle" && coolingDown) {
    return {
      can_dismiss: true,
      can_repair_to_idle: false,
      can_repair_to_blocked: false,
      can_retry_dispatch: false,
      disabled_reason:
        "Cooldown is still active. Wait for cooldown to expire before retrying or repairing this session.",
      risk:
        currentTaskRisk ?? (hasProviderBinding ? "Provider binding is still present while cooldown is active." : null),
      requires_confirmation: false
    };
  }

  return {
    can_dismiss: true,
    can_repair_to_idle: false,
    can_repair_to_blocked: false,
    can_retry_dispatch: Boolean(input.current_task_id || input.last_failure_kind || input.provider_session_id),
    disabled_reason: "Session is already idle and does not need manual repair.",
    risk: currentTaskRisk ?? (hasProviderBinding ? "Provider binding is still present on this idle session." : null),
    requires_confirmation: false
  };
}

export function buildRecoveryActionRejection(
  sessionId: string,
  action: "dismiss" | "repair_to_idle" | "repair_to_blocked",
  input: ResolveRecoveryActionsInput,
  policy: RecoveryActionPolicy
): RecoveryActionRejection {
  const actionLabel =
    action === "dismiss" ? "dismiss" : action === "repair_to_idle" ? "repair to idle" : "repair to blocked";
  const defaultNextAction =
    action === "dismiss"
      ? "Leave the dismissed session as-is, or use repair to recover it when the role is ready to resume."
      : input.session_status === "running" || input.process_state === "running"
        ? "Dismiss the running session before attempting repair."
        : input.session_status === "idle"
          ? "Wait for cooldown to expire or leave the session idle if no recovery is needed."
          : "Review the current task and status before attempting manual recovery.";
  return {
    code: "SESSION_RECOVERY_ACTION_NOT_ALLOWED",
    message: `${actionLabel} is not allowed for session '${sessionId}' while status is '${input.session_status}'`,
    next_action: defaultNextAction,
    disabled_reason: policy.disabled_reason,
    risk: policy.risk,
    details: {
      action,
      session_id: sessionId,
      status: input.session_status
    }
  };
}
