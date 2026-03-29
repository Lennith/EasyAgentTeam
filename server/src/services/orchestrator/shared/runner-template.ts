import type { OrchestratorRunnerExecutionAdapter, OrchestratorRunnerLifecycleAdapter } from "./contracts.js";

export async function executeOrchestratorRunner<TInput, TContext, TExecutionResult, TOutput>(
  input: TInput,
  execution: OrchestratorRunnerExecutionAdapter<TInput, TContext, TExecutionResult, TOutput>,
  lifecycle: OrchestratorRunnerLifecycleAdapter<TContext, TExecutionResult>
): Promise<TOutput> {
  const context = await execution.createContext(input);
  await lifecycle.appendStarted(context);

  try {
    const result = await execution.execute(context);
    await lifecycle.appendSuccess?.(context, result);
    return await execution.onSuccess(context, result);
  } catch (error) {
    const terminal = execution.classifyFailure?.(context, error) ?? "failure";
    if (terminal === "timeout") {
      await lifecycle.appendTimeout?.(context, error);
    } else if (terminal === "escalated") {
      await lifecycle.appendEscalated?.(context, error);
    } else {
      await lifecycle.appendFailure?.(context, error);
    }
    if (terminal === "escalated" && execution.onEscalated) {
      return await execution.onEscalated(context, error);
    }
    return await execution.onFailure(context, error);
  }
}
