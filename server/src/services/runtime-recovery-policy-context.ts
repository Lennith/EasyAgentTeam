import {
  resolveRecoveryActions,
  type RecoveryActionPolicy,
  type RecoveryFailureKind,
  type RecoveryMappingState,
  type RecoveryProcessState,
  type RecoveryScopeKind,
  type RecoveryStatus,
  type ResolveRecoveryActionsInput
} from "./runtime-recovery-action-policy.js";

export interface RecoveryPolicySessionLike {
  role: string;
  sessionId: string;
  status: RecoveryStatus;
  currentTaskId?: string | null;
  cooldownUntil?: string | null;
  lastFailureKind?: RecoveryFailureKind | null;
  providerSessionId?: string | null;
  agentPid?: number | null;
}

export interface BuildRecoveryPolicyContextInput {
  scope_kind: RecoveryScopeKind;
  session: RecoveryPolicySessionLike;
  role_session_map?: Record<string, string>;
  last_failure_kind?: RecoveryFailureKind | null;
  provider_session_id?: string | null;
  process_state?: RecoveryProcessState;
}

export interface RecoveryPolicyContextResult {
  input: ResolveRecoveryActionsInput;
  policy: RecoveryActionPolicy;
}

export function resolveRecoveryMappingState(
  roleSessionMap: Record<string, string> | undefined,
  role: string,
  sessionId: string
): RecoveryMappingState {
  const mapped = roleSessionMap?.[role];
  if (!mapped) {
    return "none";
  }
  return mapped === sessionId ? "authoritative" : "stale";
}

export function resolveRecoveryProcessState(
  status: RecoveryStatus,
  agentPid: number | null | undefined
): RecoveryProcessState {
  if (status === "running") {
    return "running";
  }
  if (typeof agentPid === "number" && Number.isFinite(agentPid) && agentPid > 0) {
    return "unknown";
  }
  return "not_running";
}

export function buildRecoveryPolicyInput(input: BuildRecoveryPolicyContextInput): ResolveRecoveryActionsInput {
  return {
    scope_kind: input.scope_kind,
    session_status: input.session.status,
    current_task_id: input.session.currentTaskId ?? null,
    cooldown_until: input.session.cooldownUntil ?? null,
    last_failure_kind: input.last_failure_kind ?? input.session.lastFailureKind ?? null,
    provider_session_id: input.provider_session_id ?? input.session.providerSessionId ?? null,
    role_session_mapping: resolveRecoveryMappingState(
      input.role_session_map,
      input.session.role,
      input.session.sessionId
    ),
    process_state: input.process_state ?? resolveRecoveryProcessState(input.session.status, input.session.agentPid)
  };
}

export function buildRecoveryPolicyContext(input: BuildRecoveryPolicyContextInput): RecoveryPolicyContextResult {
  const resolvedInput = buildRecoveryPolicyInput(input);
  return {
    input: resolvedInput,
    policy: resolveRecoveryActions(resolvedInput)
  };
}
