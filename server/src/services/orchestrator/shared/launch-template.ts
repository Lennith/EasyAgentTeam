import type { OrchestratorLaunchExecutionAdapter } from "./contracts.js";
import { executeOrchestratorRunner } from "./runner-template.js";

export async function executeOrchestratorLaunch<TInput, TContext, TExecutionResult, TOutput>(
  input: TInput,
  adapter: OrchestratorLaunchExecutionAdapter<TInput, TContext, TExecutionResult, TOutput>
): Promise<TOutput> {
  return await executeOrchestratorRunner(
    input,
    {
      createContext: async (runnerInput: TInput) => await adapter.createContext(runnerInput),
      execute: async (context: TContext) => await adapter.execute(context),
      onSuccess: async (context: TContext, result: TExecutionResult) => await adapter.onSuccess(context, result),
      onFailure: async (context: TContext, error: unknown) => await adapter.onFailure(context, error)
    },
    {
      appendStarted: async (context: TContext) => await adapter.appendStarted(context)
    }
  );
}
