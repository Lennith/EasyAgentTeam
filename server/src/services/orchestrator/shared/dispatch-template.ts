import { withOrchestratorDispatchGate } from "./dispatch-lifecycle.js";
import type { OrchestratorSingleFlightGate } from "../kernel/single-flight.js";
import type {
  OrchestratorDispatchExecutionAdapter,
  OrchestratorDispatchFinalizeAdapter,
  OrchestratorDispatchMutationAdapter,
  OrchestratorDispatchPreflightAdapter
} from "./contracts.js";

export interface OrchestratorDispatchTemplateOptions<
  TState = unknown,
  TSelection = unknown,
  TPrepared = void,
  TResult = unknown
> {
  state: TState;
  maxDispatches: number;
  gate: OrchestratorSingleFlightGate;
  preflight: OrchestratorDispatchPreflightAdapter<TState, TResult>;
  mutation: OrchestratorDispatchMutationAdapter<TState, TSelection, TPrepared>;
  execution: OrchestratorDispatchExecutionAdapter<TState, TSelection, TPrepared, TResult>;
  finalize?: OrchestratorDispatchFinalizeAdapter<TState, TResult>;
}

export interface OrchestratorDispatchTemplateResult<TResult = unknown> {
  results: TResult[];
  dispatchedCount: number;
}

export async function runOrchestratorDispatchTemplate<TState, TSelection, TPrepared, TResult>(
  options: OrchestratorDispatchTemplateOptions<TState, TSelection, TPrepared, TResult>
): Promise<OrchestratorDispatchTemplateResult<TResult>> {
  const { state, maxDispatches, gate, preflight, mutation, execution, finalize } = options;
  const beforeLoopResult = await preflight.beforeLoop(state);
  if (beforeLoopResult !== null) {
    await finalize?.afterLoop?.(state, [beforeLoopResult]);
    return {
      results: [beforeLoopResult],
      dispatchedCount: execution.shouldCountAsDispatch?.(beforeLoopResult, state) ? 1 : 0
    };
  }

  const results: TResult[] = [];
  let dispatchedCount = 0;

  for (let index = 0; index < maxDispatches; index += 1) {
    const beforeIterationResult = await preflight.beforeIteration?.(state);
    if (beforeIterationResult !== null && beforeIterationResult !== undefined) {
      if (results.length === 0) {
        results.push(beforeIterationResult);
      }
      break;
    }

    const decision = await execution.selectNext(state);
    if (decision.status === "none") {
      const noSelectionResult = execution.buildNoSelectionResult(state, decision.busyFound);
      if (noSelectionResult !== null && results.length === 0) {
        results.push(noSelectionResult);
      }
      break;
    }

    const result =
      decision.status === "skipped"
        ? decision.result
        : await withOrchestratorDispatchGate<TResult>(
            gate,
            execution.getSingleFlightKey(decision.selection, state),
            () => execution.createSingleFlightBusyResult(decision.selection, state),
            async () => {
              const prepared = await mutation.prepareDispatch(decision.selection, state);
              return await execution.dispatch(decision.selection, prepared, state);
            }
          );

    results.push(result);
    if (execution.shouldCountAsDispatch?.(result, state)) {
      dispatchedCount += 1;
    }
    await finalize?.afterDispatch?.(result, state);
    if (!(execution.shouldContinue?.(result, state) ?? false)) {
      break;
    }
  }

  await finalize?.afterLoop?.(state, results);
  return { results, dispatchedCount };
}
