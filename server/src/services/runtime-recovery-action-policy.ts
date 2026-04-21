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
  last_failure_event_id?: string | null;
  last_failure_dispatch_id?: string | null;
  last_failure_message_id?: string | null;
  last_failure_task_id?: string | null;
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

export type RecoveryCommandAction = "dismiss" | "repair_to_idle" | "repair_to_blocked" | "retry_dispatch";

export interface RecoveryActionRejection {
  code:
    | "SESSION_RECOVERY_ACTION_NOT_ALLOWED"
    | "SESSION_RECOVERY_CONFIRMATION_REQUIRED"
    | "SESSION_RETRY_GUARD_REQUIRED"
    | "SESSION_RETRY_DISPATCH_NOT_ALLOWED"
    | "SESSION_DISMISS_EXTERNAL_STOP_UNCONFIRMED";
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

export interface RecoveryRetryDispatchResult<TSession> {
  action: "retry_dispatch";
  session: TSession;
  current_task_id: string | null;
  dispatch_scope: "task" | "role";
  accepted: boolean;
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

function mergeRiskMessages(...messages: Array<string | null | undefined>): string | null {
  const normalized = messages
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  if (normalized.length === 0) {
    return null;
  }
  return normalized.join(" ");
}

function hasRecoveryFailureContext(input: ResolveRecoveryActionsInput): boolean {
  return Boolean(
    input.last_failure_event_id ||
    input.last_failure_dispatch_id ||
    input.last_failure_message_id ||
    input.last_failure_task_id
  );
}

export function resolveRecoveryActions(input: ResolveRecoveryActionsInput): RecoveryActionPolicy {
  const currentTaskRisk = buildCurrentTaskRisk(input.current_task_id ?? null);
  const coolingDown = isCooldownActive(input.cooldown_until ?? null);
  const hasProviderBinding = Boolean(input.provider_session_id);
  const processStateUnknown = input.process_state === "unknown";

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

  if (processStateUnknown) {
    return {
      can_dismiss: true,
      can_repair_to_idle: false,
      can_repair_to_blocked: false,
      can_retry_dispatch: false,
      disabled_reason:
        "Local process state is unknown. Dismiss the session before attempting repair or retry dispatch.",
      risk: mergeRiskMessages(currentTaskRisk, "A local agent process may still be attached to this session."),
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
      risk: mergeRiskMessages(
        bindingRisk,
        currentTaskRisk,
        bindingRisk || currentTaskRisk ? null : "Manual recovery should be used only when the role is ready to resume."
      ),
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

  if (input.session_status === "idle" && input.role_session_mapping === "stale") {
    return {
      can_dismiss: true,
      can_repair_to_idle: false,
      can_repair_to_blocked: false,
      can_retry_dispatch: false,
      disabled_reason: "Session is no longer the authoritative session for this role.",
      risk: mergeRiskMessages(
        currentTaskRisk,
        "Retry dispatch should be issued against the authoritative session for this role."
      ),
      requires_confirmation: false
    };
  }

  return {
    can_dismiss: true,
    can_repair_to_idle: false,
    can_repair_to_blocked: false,
    can_retry_dispatch: hasRecoveryFailureContext(input),
    disabled_reason: hasRecoveryFailureContext(input)
      ? "Session is already idle and ready for guarded retry dispatch."
      : "Session is already idle but has no active failure context for retry dispatch.",
    risk: currentTaskRisk ?? (hasProviderBinding ? "Provider binding is still present on this idle session." : null),
    requires_confirmation: false
  };
}

export function buildRecoveryActionRejection(
  sessionId: string,
  action: RecoveryCommandAction,
  input: ResolveRecoveryActionsInput,
  policy: RecoveryActionPolicy,
  code: "SESSION_RECOVERY_ACTION_NOT_ALLOWED" | "SESSION_RETRY_DISPATCH_NOT_ALLOWED" = action === "retry_dispatch"
    ? "SESSION_RETRY_DISPATCH_NOT_ALLOWED"
    : "SESSION_RECOVERY_ACTION_NOT_ALLOWED"
): RecoveryActionRejection {
  const actionLabel =
    action === "dismiss"
      ? "dismiss"
      : action === "repair_to_idle"
        ? "repair to idle"
        : action === "repair_to_blocked"
          ? "repair to blocked"
          : "retry dispatch";
  const defaultNextAction =
    action === "dismiss"
      ? "Leave the dismissed session as-is, or use repair to recover it when the role is ready to resume."
      : action === "retry_dispatch"
        ? input.session_status === "idle" && input.cooldown_until
          ? "Wait for cooldown to expire before retrying dispatch for this session."
          : input.session_status === "dismissed"
            ? "Repair the dismissed session to idle before requesting retry dispatch."
            : input.session_status === "blocked"
              ? "Repair the blocked session to idle before retrying dispatch."
              : "Review the session context and wait until it becomes idle before retrying dispatch."
        : input.session_status === "running" || input.process_state === "running"
          ? "Dismiss the running session before attempting repair."
          : input.session_status === "idle"
            ? "Wait for cooldown to expire or leave the session idle if no recovery is needed."
            : "Review the current task and status before attempting manual recovery.";
  return {
    code,
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

export function buildRecoveryConfirmationRequired(
  sessionId: string,
  action: RecoveryCommandAction,
  input: ResolveRecoveryActionsInput,
  policy: RecoveryActionPolicy
): RecoveryActionRejection {
  return {
    code: "SESSION_RECOVERY_CONFIRMATION_REQUIRED",
    message: `confirmation is required before executing '${action}' for session '${sessionId}'`,
    next_action: "Repeat the same recovery command with confirm=true after reviewing the risk details.",
    disabled_reason: policy.disabled_reason,
    risk: policy.risk,
    details: {
      action,
      session_id: sessionId,
      status: input.session_status,
      requires_confirmation: true
    }
  };
}

export function hasConfirmedDismissExternalStop(
  providerCancel: RecoveryProviderCancelResult,
  processTermination: RecoveryProcessTerminationView | null
): boolean {
  if (providerCancel.confirmed) {
    return true;
  }
  if (providerCancel.result === "not_found" || providerCancel.result === "not_supported") {
    return true;
  }
  const processResult = processTermination?.result ?? null;
  return processResult === "killed" || processResult === "not_found";
}

export function buildDismissExternalStopUnconfirmed(
  sessionId: string,
  previousStatus: RecoveryStatus,
  providerCancel: RecoveryProviderCancelResult,
  processTermination: RecoveryProcessTerminationView | null,
  warnings: string[]
): RecoveryActionRejection {
  return {
    code: "SESSION_DISMISS_EXTERNAL_STOP_UNCONFIRMED",
    message: `external stop could not be confirmed for session '${sessionId}'`,
    next_action: "Inspect provider/process state, then retry dismiss once external execution is confirmed stopped.",
    disabled_reason: "External execution stop is not confirmed.",
    risk: "Local dismiss was not written because provider or process termination could not be confirmed.",
    details: {
      action: "dismiss",
      session_id: sessionId,
      status: previousStatus,
      provider_cancel: providerCancel,
      process_termination: processTermination,
      warnings
    }
  };
}
