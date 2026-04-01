import type { OrchestratorTaskActionPipelineAdapter } from "./contracts.js";

export async function runOrchestratorTaskActionPipeline<
  TInput,
  TParsed,
  TAuthorized,
  TGated,
  TApplied,
  TConverged,
  TOutput
>(
  input: TInput,
  adapter: OrchestratorTaskActionPipelineAdapter<TInput, TParsed, TAuthorized, TGated, TApplied, TConverged, TOutput>
): Promise<TOutput> {
  const parsed = await adapter.parse(input);
  const authorized = await adapter.authorize(parsed);
  const gated = await adapter.checkDependencyGate(authorized);
  const applied = await adapter.apply(gated);
  const converged = await adapter.convergeRuntime(applied);
  return await adapter.emit(converged);
}
