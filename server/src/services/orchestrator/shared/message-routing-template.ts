import type { OrchestratorMessageRoutingAdapter } from "./contracts.js";

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
