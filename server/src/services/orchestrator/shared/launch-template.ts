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
      onFailure: async (context: TContext, error: unknown) => await adapter.onFailure(context, error),
      classifyFailure: adapter.classifyFailure
        ? (context: TContext, error: unknown) => adapter.classifyFailure!(context, error)
        : undefined,
      onEscalated: adapter.onEscalated
        ? async (context: TContext, error: unknown) => await adapter.onEscalated!(context, error)
        : undefined
    },
    {
      appendStarted: async (context: TContext) => await adapter.appendStarted(context),
      appendSuccess: adapter.appendSuccess
        ? async (context: TContext, result: TExecutionResult) => await adapter.appendSuccess!(context, result)
        : undefined,
      appendFailure: adapter.appendFailure
        ? async (context: TContext, error: unknown) => await adapter.appendFailure!(context, error)
        : undefined,
      appendTimeout: adapter.appendTimeout
        ? async (context: TContext, error: unknown) => await adapter.appendTimeout!(context, error)
        : undefined,
      appendEscalated: adapter.appendEscalated
        ? async (context: TContext, error: unknown) => await adapter.appendEscalated!(context, error)
        : undefined
    }
  );
}
