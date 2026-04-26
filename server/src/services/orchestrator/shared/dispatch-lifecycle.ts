import type { OrchestratorSingleFlightGate } from "./kernel/single-flight.js";
import type { OrchestratorDispatchLifecycleEventAdapter } from "./contracts.js";
import { readPayloadString } from "./dispatch-engine.js";
import { isProviderLaunchError, serializeProviderLaunchError } from "../../provider-launch-error.js";

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

export interface OrchestratorDispatchTerminalState {
  closed: boolean;
  timedOut: boolean;
}

export interface OrchestratorDispatchLifecyclePayloadDefinition {
  options: OrchestratorDispatchLifecyclePayloadOptions;
  extra?: Record<string, unknown>;
}

export interface OrchestratorDispatchLifecycleEventAdapterFactoryOptions<
  TScopeContext,
  TStartedDetails,
  TFinishedDetails,
  TFailedDetails,
  TEvent
> {
  append(scope: TScopeContext, event: TEvent): Promise<void>;
  buildEvent(
    scope: TScopeContext,
    eventType: "ORCHESTRATOR_DISPATCH_STARTED" | "ORCHESTRATOR_DISPATCH_FINISHED" | "ORCHESTRATOR_DISPATCH_FAILED",
    payload: Record<string, unknown>
  ): TEvent;
  buildStartedPayload(scope: TScopeContext, details: TStartedDetails): OrchestratorDispatchLifecyclePayloadDefinition;
  buildFinishedPayload(scope: TScopeContext, details: TFinishedDetails): OrchestratorDispatchLifecyclePayloadDefinition;
  buildFailedPayload(scope: TScopeContext, details: TFailedDetails): OrchestratorDispatchLifecyclePayloadDefinition;
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

export function createOrchestratorDispatchLifecycleEventAdapter<
  TScopeContext,
  TStartedDetails,
  TFinishedDetails,
  TFailedDetails,
  TEvent
>(
  options: OrchestratorDispatchLifecycleEventAdapterFactoryOptions<
    TScopeContext,
    TStartedDetails,
    TFinishedDetails,
    TFailedDetails,
    TEvent
  >
): OrchestratorDispatchLifecycleEventAdapter<TScopeContext, TStartedDetails, TFinishedDetails, TFailedDetails> {
  const appendLifecycleEvent = async (
    scope: TScopeContext,
    eventType: "ORCHESTRATOR_DISPATCH_STARTED" | "ORCHESTRATOR_DISPATCH_FINISHED" | "ORCHESTRATOR_DISPATCH_FAILED",
    definition: OrchestratorDispatchLifecyclePayloadDefinition
  ): Promise<void> => {
    await options.append(
      scope,
      options.buildEvent(scope, eventType, buildOrchestratorDispatchPayload(definition.options, definition.extra ?? {}))
    );
  };

  return {
    appendStarted: async (scope, details) =>
      await appendLifecycleEvent(scope, "ORCHESTRATOR_DISPATCH_STARTED", options.buildStartedPayload(scope, details)),
    appendFinished: async (scope, details) =>
      await appendLifecycleEvent(scope, "ORCHESTRATOR_DISPATCH_FINISHED", options.buildFinishedPayload(scope, details)),
    appendFailed: async (scope, details) =>
      await appendLifecycleEvent(scope, "ORCHESTRATOR_DISPATCH_FAILED", options.buildFailedPayload(scope, details))
  };
}

export function resolveOrchestratorErrorMessage(error: unknown, fallback = "Unknown error"): string {
  if (isProviderLaunchError(error)) {
    return serializeProviderLaunchError(error);
  }
  if (error instanceof Error) {
    const message = error.message.trim();
    return message.length > 0 ? message : fallback;
  }
  if (typeof error === "string") {
    const message = error.trim();
    return message.length > 0 ? message : fallback;
  }
  if (error === null || error === undefined) {
    return fallback;
  }
  const serialized = String(error).trim();
  if (!serialized || serialized === "[object Object]") {
    return fallback;
  }
  return serialized;
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

function readDispatchId(payload: Record<string, unknown>): string | undefined {
  return readPayloadString(payload, "dispatchId") ?? readPayloadString(payload, "dispatch_id");
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
    const payload = event.payload as Record<string, unknown>;
    if (
      (event.eventType === "ORCHESTRATOR_DISPATCH_FINISHED" || event.eventType === "ORCHESTRATOR_DISPATCH_FAILED") &&
      readDispatchId(payload) === dispatchId
    ) {
      return payload.timedOut === true || payload.timed_out === true;
    }
    if (
      event.eventType !== "SESSION_HEARTBEAT_TIMEOUT" &&
      event.eventType !== "RUNNER_TIMEOUT_SOFT" &&
      event.eventType !== "RUNNER_TIMEOUT_ESCALATED"
    ) {
      return false;
    }
    return readDispatchId(payload) === dispatchId;
  });
}

export function resolveOrchestratorDispatchTerminalState<T extends OrchestratorDispatchEventLike>(
  events: readonly T[],
  sessionId: string,
  dispatchId: string
): OrchestratorDispatchTerminalState {
  return {
    closed: isOrchestratorDispatchClosed(events, dispatchId),
    timedOut: wasOrchestratorDispatchTimedOut(events, sessionId, dispatchId)
  };
}

export async function loadOrchestratorDispatchTerminalState<T extends OrchestratorDispatchEventLike>(
  loadEvents: () => Promise<readonly T[]>,
  sessionId: string,
  dispatchId: string
): Promise<OrchestratorDispatchTerminalState> {
  const events = await loadEvents();
  return resolveOrchestratorDispatchTerminalState(events, sessionId, dispatchId);
}

export async function applyOrchestratorDispatchTerminalState<T extends OrchestratorDispatchEventLike>(
  loadEvents: () => Promise<readonly T[]>,
  sessionId: string,
  dispatchId: string,
  operation: (state: OrchestratorDispatchTerminalState) => Promise<void> | void,
  options: { skipWhenClosed?: boolean } = {}
): Promise<OrchestratorDispatchTerminalState> {
  const terminalState = await loadOrchestratorDispatchTerminalState(loadEvents, sessionId, dispatchId);
  const skipWhenClosed = options.skipWhenClosed ?? true;
  if (skipWhenClosed && terminalState.closed) {
    return terminalState;
  }
  await operation(terminalState);
  return terminalState;
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
