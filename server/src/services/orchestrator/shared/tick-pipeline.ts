import type {
  OrchestratorCompletionAdapter,
  OrchestratorReminderAdapter,
  OrchestratorSessionRuntimeAdapter
} from "./contracts.js";

export type OrchestratorTickPhaseName =
  | "timeout"
  | "finalize"
  | "reminder"
  | "completion"
  | "observability"
  | "autoDispatchBudget";

export const DEFAULT_ORCHESTRATOR_TICK_PHASE_ORDER = [
  "timeout",
  "reminder",
  "completion",
  "observability",
  "autoDispatchBudget"
] as const satisfies readonly OrchestratorTickPhaseName[];

export type OrchestratorTickDirective = "continue" | "stop";

export interface OrchestratorTickPhase<TScopeContext = unknown> {
  name: OrchestratorTickPhaseName;
  run(scope: TScopeContext): Promise<OrchestratorTickDirective | void>;
}

export interface OrchestratorTickPipeline<TScopeContext = unknown> {
  readonly phaseOrder: readonly OrchestratorTickPhaseName[];
  run(scope: TScopeContext): Promise<void>;
}

export interface AdapterBackedOrchestratorTickPipelineOptions<TScopeContext = unknown> {
  phaseOrder?: readonly OrchestratorTickPhaseName[];
  scopeIsOnHold?(scope: TScopeContext): boolean;
  sessionRuntime: OrchestratorSessionRuntimeAdapter<TScopeContext>;
  reminder?: OrchestratorReminderAdapter<TScopeContext>;
  completion?: OrchestratorCompletionAdapter<TScopeContext>;
  updateAutoDispatchBudget?(scope: TScopeContext): Promise<void>;
}

class DefaultOrchestratorTickPipeline<TScopeContext> implements OrchestratorTickPipeline<TScopeContext> {
  readonly phaseOrder: readonly OrchestratorTickPhaseName[];

  constructor(private readonly phases: readonly OrchestratorTickPhase<TScopeContext>[]) {
    this.phaseOrder = phases.map((phase) => phase.name);
  }

  async run(scope: TScopeContext): Promise<void> {
    for (const phase of this.phases) {
      const directive = await phase.run(scope);
      if (directive === "stop") {
        return;
      }
    }
  }
}

export function createOrchestratorTickPipeline<TScopeContext>(
  phases: readonly OrchestratorTickPhase<TScopeContext>[]
): OrchestratorTickPipeline<TScopeContext> {
  return new DefaultOrchestratorTickPipeline(phases);
}

export function createAdapterBackedOrchestratorTickPipeline<TScopeContext>(
  options: AdapterBackedOrchestratorTickPipelineOptions<TScopeContext>
): OrchestratorTickPipeline<TScopeContext> {
  const phaseOrder = options.phaseOrder ?? DEFAULT_ORCHESTRATOR_TICK_PHASE_ORDER;
  const scopeIsOnHold = options.scopeIsOnHold ?? (() => false);
  const phases: OrchestratorTickPhase<TScopeContext>[] = [];

  for (const phaseName of phaseOrder) {
    switch (phaseName) {
      case "timeout":
        phases.push({
          name: "timeout",
          run: async (scope) => {
            await options.sessionRuntime.markTimedOut(scope);
          }
        });
        break;
      case "finalize":
        if (!options.completion?.finalize) {
          break;
        }
        {
          const finalize = options.completion.finalize;
          phases.push({
            name: "finalize",
            run: async (scope) => {
              if (await finalize(scope)) {
                return "stop";
              }
              return "continue";
            }
          });
        }
        break;
      case "reminder":
        if (!options.reminder) {
          break;
        }
        {
          const checkReminders = options.reminder.checkReminders.bind(options.reminder);
          phases.push({
            name: "reminder",
            run: async (scope) => {
              if (scopeIsOnHold(scope)) {
                return "continue";
              }
              await checkReminders(scope);
              return "continue";
            }
          });
        }
        break;
      case "completion":
        if (!options.completion) {
          break;
        }
        {
          const runCompletion = options.completion.runCompletion.bind(options.completion);
          phases.push({
            name: "completion",
            run: async (scope) => {
              if (scopeIsOnHold(scope)) {
                return "continue";
              }
              await runCompletion(scope);
              return "continue";
            }
          });
        }
        break;
      case "observability":
        if (!options.completion?.emitObservabilitySnapshot) {
          break;
        }
        {
          const emitObservabilitySnapshot = options.completion.emitObservabilitySnapshot;
          phases.push({
            name: "observability",
            run: async (scope) => {
              await emitObservabilitySnapshot(scope);
              return "continue";
            }
          });
        }
        break;
      case "autoDispatchBudget":
        if (!options.updateAutoDispatchBudget) {
          break;
        }
        {
          const updateAutoDispatchBudget = options.updateAutoDispatchBudget;
          phases.push({
            name: "autoDispatchBudget",
            run: async (scope) => {
              if (scopeIsOnHold(scope)) {
                return "continue";
              }
              await updateAutoDispatchBudget(scope);
              return "continue";
            }
          });
        }
        break;
      default: {
        const exhaustiveCheck: never = phaseName;
        throw new Error(`Unsupported orchestrator tick phase: ${String(exhaustiveCheck)}`);
      }
    }
  }

  return createOrchestratorTickPipeline(phases);
}
