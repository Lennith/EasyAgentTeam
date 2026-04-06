import type { OrchestratorMessageRoutingAdapter } from "./contracts.js";
import { createTimestampRequestId, createTimestampedIdentifier } from "./orchestrator-identifiers.js";

export interface OrchestratorMessageRouteEventPair<TEvent = unknown> {
  received: TEvent;
  routed: TEvent;
}

export interface BuildOrchestratorMessageRouteResultInput {
  requestId: string;
  messageId: string;
  messageType: string;
  taskId?: string | null;
  toRole?: string | null;
  resolvedSessionId: string;
  createdAt: string;
}

export interface OrchestratorMessageRouteResult {
  requestId: string;
  messageId: string;
  messageType: string;
  taskId: string | null;
  toRole: string | null;
  resolvedSessionId: string;
  createdAt: string;
}

export interface ResolveOrchestratorMessageEnvelopeMetadataInput {
  requestId?: string | null;
  messageId?: string | null;
  createdAt?: string | null;
  createRequestId?: () => string;
  createMessageId?: () => string;
  createCreatedAt?: () => string;
}

export interface OrchestratorMessageEnvelopeMetadata {
  requestId: string;
  messageId: string;
  createdAt: string;
}

export async function appendOrchestratorMessageRouteEventPair<TEvent>(
  appendEvent: (event: TEvent) => Promise<void>,
  pair: OrchestratorMessageRouteEventPair<TEvent>
): Promise<void> {
  await appendEvent(pair.received);
  await appendEvent(pair.routed);
}

export function buildOrchestratorMessageRouteResult<TExtra extends Record<string, unknown> = Record<string, never>>(
  input: BuildOrchestratorMessageRouteResultInput & TExtra
): OrchestratorMessageRouteResult & TExtra {
  return {
    ...input,
    taskId: input.taskId ?? null,
    toRole: input.toRole ?? null
  };
}

export function resolveOrchestratorMessageEnvelopeMetadata(
  input: ResolveOrchestratorMessageEnvelopeMetadataInput = {}
): OrchestratorMessageEnvelopeMetadata {
  const createRequestId = input.createRequestId ?? createTimestampRequestId;
  const createMessageId = input.createMessageId ?? createTimestampedIdentifier;
  const createCreatedAt = input.createCreatedAt ?? (() => new Date().toISOString());
  return {
    requestId: input.requestId?.trim() || createRequestId(),
    messageId: input.messageId?.trim() || createMessageId(),
    createdAt: input.createdAt?.trim() || createCreatedAt()
  };
}

export function createOrchestratorMessageRoutingUnitOfWorkRunner<TScope, TInput>(
  runInUnitOfWork: (scope: TScope, operation: () => Promise<void>) => Promise<void>
): (scope: TScope, input: TInput, operation: () => Promise<void>) => Promise<void> {
  return async (scope: TScope, _input: TInput, operation: () => Promise<void>) =>
    await runInUnitOfWork(scope, operation);
}

export async function executeOrchestratorMessageRouting<TScope, TInput, TTarget, TEnvelope, TResult>(
  scope: TScope,
  input: TInput,
  adapter: OrchestratorMessageRoutingAdapter<TScope, TInput, TTarget, TEnvelope, TResult>
): Promise<TResult> {
  const target = await adapter.resolveTarget(scope, input);
  const envelope = await adapter.normalizeEnvelope(scope, target, input);

  const persistFlow = async () => {
    await adapter.persistInbox(scope, target, envelope, input);
    await adapter.persistRouteEvent(scope, target, envelope, input);
    await adapter.touchSession(scope, target, envelope, input);
  };

  if (adapter.runInUnitOfWork) {
    await adapter.runInUnitOfWork(scope, input, persistFlow);
  } else {
    await persistFlow();
  }

  return await adapter.buildResult(scope, target, envelope, input);
}

export async function executeOrchestratorMessageRoutingInUnitOfWork<TScope, TInput, TTarget, TEnvelope, TResult>(
  scope: TScope,
  input: TInput,
  runInUnitOfWork: (scope: TScope, input: TInput, operation: () => Promise<void>) => Promise<void>,
  adapter: Omit<OrchestratorMessageRoutingAdapter<TScope, TInput, TTarget, TEnvelope, TResult>, "runInUnitOfWork">
): Promise<TResult> {
  return await executeOrchestratorMessageRouting(scope, input, {
    ...adapter,
    runInUnitOfWork
  });
}
