import { hasOpenTaskDispatch } from "./dispatch-engine.js";
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
): Promise<boolean> {
  const events = await input.listEvents();
  const duplicateFound = hasOpenTaskDispatch(events, input.taskId, input.sessionId);
  if (duplicateFound) {
    await input.onDuplicateDetected?.();
  }
  return duplicateFound;
}

export async function buildOrchestratorDuplicateTaskDispatchSkipResult<TResult>(
  input: OrchestratorDuplicateTaskDispatchSkipInput<TResult>
): Promise<TResult | null> {
  const duplicateFound = await guardOrchestratorDuplicateTaskDispatch(input);
  if (!duplicateFound) {
    return null;
  }
  return input.buildSkippedResult();
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
