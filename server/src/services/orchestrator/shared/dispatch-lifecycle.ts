import type { OrchestratorSingleFlightGate } from "../kernel/single-flight.js";
import { readPayloadString } from "../dispatch-engine.js";

export interface OrchestratorDispatchLifecyclePayloadOptions {
  dispatchId: string;
  requestId: string;
  dispatchKind: string | null;
  messageId?: string | null;
}

export interface OrchestratorDispatchEventLike {
  eventType: string;
  createdAt: string;
  payload: unknown;
  sessionId?: string;
}

export function buildOrchestratorDispatchPayload(
  options: OrchestratorDispatchLifecyclePayloadOptions,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    requestId: options.requestId,
    dispatchId: options.dispatchId,
    dispatchKind: options.dispatchKind
  };
  if (Object.prototype.hasOwnProperty.call(options, "messageId")) {
    payload.messageId = options.messageId ?? null;
  }
  return { ...payload, ...extra };
}

export function isOrchestratorDispatchClosed<T extends OrchestratorDispatchEventLike>(
  events: readonly T[],
  dispatchId: string
): boolean {
  return events.some((event) => {
    if (event.eventType !== "ORCHESTRATOR_DISPATCH_FINISHED" && event.eventType !== "ORCHESTRATOR_DISPATCH_FAILED") {
      return false;
    }
    const payload = event.payload as Record<string, unknown>;
    return readPayloadString(payload, "dispatchId") === dispatchId;
  });
}

export function wasOrchestratorDispatchTimedOut<T extends OrchestratorDispatchEventLike>(
  events: readonly T[],
  sessionId: string,
  dispatchId: string
): boolean {
  return events.some((event) => {
    if (event.sessionId !== sessionId) {
      return false;
    }
    if (
      event.eventType !== "SESSION_HEARTBEAT_TIMEOUT" &&
      event.eventType !== "RUNNER_TIMEOUT_SOFT" &&
      event.eventType !== "RUNNER_TIMEOUT_ESCALATED"
    ) {
      return false;
    }
    const payload = event.payload as Record<string, unknown>;
    return readPayloadString(payload, "dispatchId") === dispatchId;
  });
}

export async function withOrchestratorDispatchGate<TResult>(
  gate: OrchestratorSingleFlightGate,
  key: string,
  onBusy: () => Promise<TResult> | TResult,
  operation: () => Promise<TResult> | TResult
): Promise<TResult> {
  if (!gate.tryAdd(key)) {
    return await onBusy();
  }
  try {
    return await operation();
  } finally {
    gate.delete(key);
  }
}
