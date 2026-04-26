import { findLatestOpenTaskDispatch, readPayloadString } from "./dispatch-engine.js";
import type { OrchestratorDispatchSelectionKind, NormalizedDispatchSelectionResult } from "./contracts.js";

export interface OrchestratorDispatchSessionAvailabilityInput {
  sessionStatus: string;
  onlyIdle: boolean;
  force: boolean;
  cooldownUntil?: string | null;
  hasInFlightDispatch?: boolean;
  treatRunningAsBusy?: boolean;
  nowMs?: number;
}

export interface OrchestratorDispatchSessionAvailabilityResult {
  available: boolean;
  busy: boolean;
  reason?: string;
}

interface DispatchEventLike {
  eventType: string;
  createdAt: string;
  payload: unknown;
  taskId?: string;
  sessionId?: string;
}

export interface OrchestratorDuplicateTaskDispatchGuardInput<TEvent extends DispatchEventLike = DispatchEventLike> {
  taskId: string;
  sessionId: string;
  listEvents(): Promise<TEvent[]>;
  onDuplicateDetected?(): Promise<void>;
  onStaleDuplicateRecovered?(details: {
    dispatchId: string;
    startedAt: string;
    requestId: string | null;
    messageId: string | null;
    dispatchKind: string | null;
  }): Promise<void>;
  sessionStatus?: string;
  sessionLastDispatchId?: string | null;
  nowMs?: number;
  staleDuplicateWindowMs?: number;
}

export interface OrchestratorDuplicateTaskDispatchSkipInput<
  TResult,
  TEvent extends DispatchEventLike = DispatchEventLike
> extends OrchestratorDuplicateTaskDispatchGuardInput<TEvent> {
  buildSkippedResult(): TResult;
}

export interface BuildNormalizedDispatchSelectionResultInput<
  TSession,
  TMessage,
  TDispatchKind extends OrchestratorDispatchSelectionKind | null = OrchestratorDispatchSelectionKind | null
> {
  role: string;
  session: TSession;
  dispatchKind: TDispatchKind;
  taskId: string | null;
  message: TMessage | null;
  requestId: string | null;
  skipReason?: string;
  terminalOutcome?: string;
}

export interface OrchestratorDuplicateTaskDispatchGuardResult {
  duplicateFound: boolean;
  staleRecovered: boolean;
  openDispatch?: {
    dispatchId: string;
    startedAt: string;
    requestId: string | null;
    messageId: string | null;
    dispatchKind: string | null;
  };
}

const DEFAULT_STALE_DUPLICATE_WINDOW_MS = 90_000;

export function evaluateOrchestratorDispatchSessionAvailability(
  input: OrchestratorDispatchSessionAvailabilityInput
): OrchestratorDispatchSessionAvailabilityResult {
  const {
    sessionStatus,
    onlyIdle,
    force,
    cooldownUntil,
    hasInFlightDispatch = false,
    treatRunningAsBusy = true,
    nowMs = Date.now()
  } = input;
  if (onlyIdle && sessionStatus !== "idle") {
    return {
      available: false,
      busy: true,
      reason: `session status is ${sessionStatus}`
    };
  }
  if (!force && hasInFlightDispatch) {
    return {
      available: false,
      busy: true,
      reason: "session already dispatching"
    };
  }
  if (!force && sessionStatus === "blocked") {
    return {
      available: false,
      busy: true,
      reason: "session status is blocked"
    };
  }
  if (!force && treatRunningAsBusy && sessionStatus === "running") {
    return {
      available: false,
      busy: true,
      reason: "session status is running"
    };
  }
  if (!force && cooldownUntil) {
    const cooldownUntilMs = Date.parse(cooldownUntil);
    if (Number.isFinite(cooldownUntilMs) && cooldownUntilMs > nowMs) {
      return {
        available: false,
        busy: true,
        reason: `session cooldown active until ${cooldownUntil}`
      };
    }
  }
  return { available: true, busy: false };
}

export async function guardOrchestratorDuplicateTaskDispatch(
  input: OrchestratorDuplicateTaskDispatchGuardInput
): Promise<OrchestratorDuplicateTaskDispatchGuardResult> {
  const events = await input.listEvents();
  const openDispatch = findLatestOpenTaskDispatch(events, input.taskId, input.sessionId);
  if (!openDispatch) {
    return {
      duplicateFound: false,
      staleRecovered: false
    };
  }
  const details = {
    dispatchId: openDispatch.dispatchId,
    startedAt: openDispatch.event.createdAt,
    requestId: readPayloadString(openDispatch.event.payload as Record<string, unknown>, "requestId") ?? null,
    messageId: readPayloadString(openDispatch.event.payload as Record<string, unknown>, "messageId") ?? null,
    dispatchKind: readPayloadString(openDispatch.event.payload as Record<string, unknown>, "dispatchKind") ?? null
  };
  if (shouldRecoverStaleDuplicateDispatch(input, details)) {
    await input.onStaleDuplicateRecovered?.(details);
    return {
      duplicateFound: false,
      staleRecovered: true,
      openDispatch: details
    };
  }
  await input.onDuplicateDetected?.();
  return {
    duplicateFound: true,
    staleRecovered: false,
    openDispatch: details
  };
}

export async function buildOrchestratorDuplicateTaskDispatchSkipResult<TResult>(
  input: OrchestratorDuplicateTaskDispatchSkipInput<TResult>
): Promise<TResult | null> {
  const guardResult = await guardOrchestratorDuplicateTaskDispatch(input);
  if (!guardResult.duplicateFound) {
    return null;
  }
  return input.buildSkippedResult();
}

function shouldRecoverStaleDuplicateDispatch(
  input: OrchestratorDuplicateTaskDispatchGuardInput,
  openDispatch: { dispatchId: string; startedAt: string; dispatchKind: string | null }
): boolean {
  if (input.sessionStatus === undefined || input.sessionStatus === "running") {
    return false;
  }
  if (openDispatch.dispatchKind !== "task") {
    return false;
  }
  const sessionLastDispatchId =
    typeof input.sessionLastDispatchId === "string" ? input.sessionLastDispatchId.trim() : "";
  if (!sessionLastDispatchId || sessionLastDispatchId !== openDispatch.dispatchId) {
    return false;
  }
  const openStartedAtMs = Date.parse(openDispatch.startedAt);
  if (!Number.isFinite(openStartedAtMs)) {
    return false;
  }
  const nowMs = input.nowMs ?? Date.now();
  const staleWindowMs =
    typeof input.staleDuplicateWindowMs === "number" && Number.isFinite(input.staleDuplicateWindowMs)
      ? Math.max(5_000, Math.floor(input.staleDuplicateWindowMs))
      : DEFAULT_STALE_DUPLICATE_WINDOW_MS;
  if (nowMs - openStartedAtMs < staleWindowMs) {
    return false;
  }

  return true;
}

export function buildNormalizedDispatchSelectionResult<
  TSession,
  TMessage,
  TDispatchKind extends OrchestratorDispatchSelectionKind | null
>(
  input: BuildNormalizedDispatchSelectionResultInput<TSession, TMessage, TDispatchKind>
): Omit<NormalizedDispatchSelectionResult<TSession, TMessage>, "dispatchKind"> & { dispatchKind: TDispatchKind } {
  return {
    role: input.role,
    session: input.session,
    dispatchKind: input.dispatchKind,
    taskId: input.taskId,
    message: input.message,
    messageId: readNormalizedMessageId(input.message),
    requestId: input.requestId,
    skipReason: input.skipReason,
    terminalOutcome: input.terminalOutcome
  };
}

function readNormalizedMessageId(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const envelope = (message as { envelope?: unknown }).envelope;
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const rawMessageId = (envelope as { message_id?: unknown }).message_id;
  return typeof rawMessageId === "string" && rawMessageId.trim().length > 0 ? rawMessageId : null;
}
