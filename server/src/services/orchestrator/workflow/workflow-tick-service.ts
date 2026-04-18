import type { WorkflowRunRecord, WorkflowRunRuntimeState, WorkflowSessionRecord } from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import type { OrchestratorKernel } from "../shared/kernel/orchestrator-kernel.js";
import type { WorkflowCompletionService } from "./workflow-completion-service.js";
import type { WorkflowDispatchService } from "./workflow-dispatch-service.js";
import type { WorkflowReminderService } from "./workflow-reminder-service.js";
import type { WorkflowSessionRuntimeService } from "./workflow-session-runtime-service.js";
import {
  createAdapterBackedOrchestratorTickPipeline,
  runAdapterBackedOrchestratorTickLoop,
  syncOrchestratorHoldState,
  type OrchestratorTickPipeline
} from "../shared/tick-pipeline.js";

interface WorkflowTickServiceOptions {
  repositories: WorkflowRepositoryBundle;
  kernel: OrchestratorKernel;
  activeRunIds: Set<string>;
  runHoldState: Map<string, boolean>;
  pruneInactiveRunScopedState(activeRunIds: Set<string>): void;
  ensureRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState>;
  sessionRuntimeService: WorkflowSessionRuntimeService;
  reminderService: WorkflowReminderService;
  completionService: WorkflowCompletionService;
  dispatchService: WorkflowDispatchService;
}

interface WorkflowTickScope {
  run: WorkflowRunRecord;
  runtime: WorkflowRunRuntimeState;
  sessions: WorkflowSessionRecord[];
}

export class WorkflowTickService {
  private readonly tickPipeline: OrchestratorTickPipeline<WorkflowTickScope>;

  constructor(private readonly options: WorkflowTickServiceOptions) {
    this.tickPipeline = createAdapterBackedOrchestratorTickPipeline<WorkflowTickScope>({
      phaseOrder: ["timeout", "finalize", "reminder", "completion", "autoDispatchBudget"],
      scopeIsOnHold: (scope) => Boolean(scope.run.holdEnabled),
      sessionRuntime: {
        markTimedOut: async (scope) => {
          await this.options.sessionRuntimeService.markTimedOutSessions(scope.run, scope.sessions);
        }
      },
      reminder: {
        checkReminders: async (scope) => {
          await this.options.reminderService.checkRoleReminders(scope.run, scope.runtime, scope.sessions);
        }
      },
      completion: {
        finalize: async (scope) => {
          return this.options.completionService.checkAndFinalizeRunByStableWindow(
            scope.run,
            scope.runtime,
            scope.sessions
          );
        },
        runCompletion: async () => {}
      },
      updateAutoDispatchBudget: async (scope) => {
        const enabled = scope.run.autoDispatchEnabled ?? true;
        const remaining = Number(scope.run.autoDispatchRemaining ?? 5);
        if (!enabled || !Number.isFinite(remaining) || remaining <= 0) {
          return;
        }
        await this.options.dispatchService.dispatchRun(scope.run.runId, {
          source: "loop",
          force: false,
          onlyIdle: true,
          maxDispatches: Math.max(1, Math.floor(remaining))
        });
      }
    });
  }

  async tickLoop(): Promise<void> {
    const runs = await this.options.repositories.workflowRuns.listRuns();
    const runningRunIds = new Set(runs.filter((run) => run.status === "running").map((run) => run.runId));
    this.options.pruneInactiveRunScopedState(runningRunIds);
    this.options.activeRunIds.clear();
    await runAdapterBackedOrchestratorTickLoop({
      kernel: this.options.kernel,
      listContexts: async () => runs,
      resolveScope: async (run) => {
        if (run.status !== "running") {
          return null;
        }
        this.options.activeRunIds.add(run.runId);
        const runtime = await this.options.ensureRuntime(run);
        const sessions = await this.options.repositories.sessions.listSessions(run.runId);
        return { run, runtime, sessions };
      },
      beforeScope: async (scope) => {
        await this.handleRunHoldState(scope.run);
      },
      tickPipeline: this.tickPipeline
    });
  }

  private async handleRunHoldState(run: WorkflowRunRecord): Promise<void> {
    const holdEnabled = Boolean(run.holdEnabled);
    await syncOrchestratorHoldState({
      scopeId: run.runId,
      holdEnabled,
      previousState: this.options.runHoldState,
      appendEvent: async (nextHoldEnabled) => {
        await this.options.repositories.events.appendEvent(run.runId, {
          eventType: nextHoldEnabled ? "ORCHESTRATOR_RUN_HOLD_ENABLED" : "ORCHESTRATOR_RUN_HOLD_DISABLED",
          source: "system",
          payload: { holdEnabled: nextHoldEnabled }
        });
      }
    });
  }
}
