import { hasOpenTaskDispatch } from "../dispatch-engine.js";

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
