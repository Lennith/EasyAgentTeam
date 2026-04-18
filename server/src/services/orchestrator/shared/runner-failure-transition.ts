export type RunnerFailureTransitionEventType =
  | "RUNNER_CONFIG_ERROR_BLOCKED"
  | "RUNNER_TRANSIENT_ERROR_SOFT"
  | "RUNNER_RUNTIME_ERROR_SOFT"
  | "RUNNER_FATAL_ERROR_DISMISSED"
  | "RUNNER_TIMEOUT_SOFT"
  | "RUNNER_TIMEOUT_ESCALATED";

export interface ResolveRunnerFailureTransitionInput {
  kind: "config" | "transient" | "timeout" | "generic";
  now?: string;
  run_id?: string | null;
  dispatch_id?: string | null;
  dispatch_kind?: "task" | "message";
  message_id?: string | null;
  error?: string | null;
  code?: string | null;
  next_action?: string | null;
  raw_status?: number | string | null;
  current_task_id?: string | null;
  preserve_current_task_id?: boolean;
  existing_error_streak?: number;
  existing_timeout_streak?: number;
  timeout_threshold?: number;
  timeout_cooldown_ms?: number;
  transient_cooldown_ms?: number;
  generic_runtime_strategy?: {
    session_status: "idle" | "dismissed";
    event_type: "RUNNER_RUNTIME_ERROR_SOFT" | "RUNNER_FATAL_ERROR_DISMISSED";
    retryable: boolean;
  };
}

export interface RunnerFailureTransitionResult {
  session_status: "idle" | "blocked" | "dismissed";
  cooldown_until: string | null;
  event_type: RunnerFailureTransitionEventType;
  event_payload: Record<string, unknown>;
  retryable: boolean;
  next_action: string | null;
  raw_status: number | string | null;
  escalated: boolean;
  session_patch: {
    status: "idle" | "blocked" | "dismissed";
    errorStreak?: number;
    timeoutStreak?: number;
    lastFailureAt: string;
    lastFailureKind: "error" | "timeout";
    cooldownUntil: string | null;
    agentPid: null;
    currentTaskId?: string | null;
  };
}

function buildCooldownUntil(nowIso: string, cooldownMs: number | undefined): string | null {
  if (!cooldownMs || cooldownMs <= 0) {
    return null;
  }
  return new Date(Date.parse(nowIso) + cooldownMs).toISOString();
}

export function resolveRunnerFailureTransition(
  input: ResolveRunnerFailureTransitionInput
): RunnerFailureTransitionResult {
  const nowIso = input.now ?? new Date().toISOString();
  const dispatchFields = {
    run_id: input.run_id ?? null,
    dispatch_id: input.dispatch_id ?? null,
    dispatch_kind: input.dispatch_kind ?? null,
    message_id: input.message_id ?? null
  };
  if (input.kind === "config") {
    const errorStreak = (input.existing_error_streak ?? 0) + 1;
    const event_payload = {
      ...dispatchFields,
      error: input.error ?? "provider configuration error",
      code: input.code ?? null,
      retryable: false,
      next_action: input.next_action ?? null,
      raw_status: input.raw_status ?? null
    };
    return {
      session_status: "blocked",
      cooldown_until: null,
      event_type: "RUNNER_CONFIG_ERROR_BLOCKED",
      event_payload,
      retryable: false,
      next_action: input.next_action ?? null,
      raw_status: input.raw_status ?? null,
      escalated: false,
      session_patch: {
        status: "blocked",
        errorStreak: errorStreak,
        lastFailureAt: nowIso,
        lastFailureKind: "error",
        cooldownUntil: null,
        agentPid: null,
        ...(input.preserve_current_task_id ? { currentTaskId: input.current_task_id ?? null } : {})
      }
    };
  }

  if (input.kind === "transient") {
    const errorStreak = (input.existing_error_streak ?? 0) + 1;
    const cooldown_until = buildCooldownUntil(nowIso, input.transient_cooldown_ms);
    const event_payload = {
      ...dispatchFields,
      error: input.error ?? "provider transient error",
      code: input.code ?? null,
      retryable: true,
      next_action: input.next_action ?? null,
      raw_status: input.raw_status ?? null,
      cooldown_until
    };
    return {
      session_status: "idle",
      cooldown_until,
      event_type: "RUNNER_TRANSIENT_ERROR_SOFT",
      event_payload,
      retryable: true,
      next_action: input.next_action ?? null,
      raw_status: input.raw_status ?? null,
      escalated: false,
      session_patch: {
        status: "idle",
        errorStreak: errorStreak,
        lastFailureAt: nowIso,
        lastFailureKind: "error",
        cooldownUntil: cooldown_until,
        agentPid: null,
        ...(input.preserve_current_task_id ? { currentTaskId: input.current_task_id ?? null } : {})
      }
    };
  }

  if (input.kind === "timeout") {
    const threshold = Math.max(1, input.timeout_threshold ?? 1);
    const timeoutStreak = (input.existing_timeout_streak ?? 0) + 1;
    const escalated = timeoutStreak >= threshold;
    const cooldown_until = escalated ? null : buildCooldownUntil(nowIso, input.timeout_cooldown_ms);
    const event_payload = {
      ...dispatchFields,
      timeout_streak: timeoutStreak,
      threshold,
      cooldown_until
    };
    return {
      session_status: escalated ? "dismissed" : "idle",
      cooldown_until,
      event_type: escalated ? "RUNNER_TIMEOUT_ESCALATED" : "RUNNER_TIMEOUT_SOFT",
      event_payload,
      retryable: !escalated,
      next_action: escalated ? null : "Wait for cooldown and retry the same task/message dispatch.",
      raw_status: null,
      escalated,
      session_patch: {
        status: escalated ? "dismissed" : "idle",
        timeoutStreak: timeoutStreak,
        lastFailureAt: nowIso,
        lastFailureKind: "timeout",
        cooldownUntil: cooldown_until,
        agentPid: null,
        ...(input.preserve_current_task_id ? { currentTaskId: input.current_task_id ?? null } : {})
      }
    };
  }

  const genericStrategy = input.generic_runtime_strategy ?? {
    session_status: "dismissed" as const,
    event_type: "RUNNER_FATAL_ERROR_DISMISSED" as const,
    retryable: false
  };
  const errorStreak = (input.existing_error_streak ?? 0) + 1;
  const event_payload = {
    ...dispatchFields,
    error: input.error ?? "runner runtime error",
    code: input.code ?? null,
    retryable: genericStrategy.retryable,
    next_action: input.next_action ?? null,
    raw_status: input.raw_status ?? null
  };
  return {
    session_status: genericStrategy.session_status,
    cooldown_until: null,
    event_type: genericStrategy.event_type,
    event_payload,
    retryable: genericStrategy.retryable,
    next_action: null,
    raw_status: null,
    escalated: false,
    session_patch: {
      status: genericStrategy.session_status,
      errorStreak: errorStreak,
      lastFailureAt: nowIso,
      lastFailureKind: "error",
      cooldownUntil: null,
      agentPid: null,
      ...(input.preserve_current_task_id ? { currentTaskId: input.current_task_id ?? null } : {})
    }
  };
}
