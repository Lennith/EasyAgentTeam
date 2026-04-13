import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import { WorkflowStoreError } from "../../../data/repository/workflow/run-repository.js";
import type { WorkflowRunRecord, WorkflowRunRuntimeSnapshot, WorkflowRunRuntimeState } from "../../../domain/models.js";
import { traceWorkflowPerfSpan } from "../../workflow-perf-trace.js";
import { convergeWorkflowRuntime } from "../shared/runtime/workflow-runtime-kernel.js";
import { buildWorkflowRuntimeSnapshot } from "./workflow-runtime-view.js";

interface WorkflowRuntimeSupportServiceContext {
  repositories: WorkflowRepositoryBundle;
  activeRunIds: Set<string>;
}

export class WorkflowRuntimeSupportService {
  constructor(private readonly context: WorkflowRuntimeSupportServiceContext) {}

  async runWorkflowTransaction<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    return this.context.repositories.runWithResolvedScope(runId, async () => operation());
  }

  async loadRunOrThrow(runId: string): Promise<WorkflowRunRecord> {
    const run = await this.context.repositories.workflowRuns.getRun(runId);
    if (!run) {
      throw new WorkflowStoreError(`run '${runId}' not found`, "RUN_NOT_FOUND");
    }
    return run;
  }

  async readConvergedRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState> {
    const storedRuntime = run.runtime ?? (await this.context.repositories.workflowRuns.readRuntime(run.runId));
    return convergeWorkflowRuntime(run, storedRuntime).runtime;
  }

  async ensureRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState> {
    return await traceWorkflowPerfSpan(
      {
        dataRoot: this.context.repositories.dataRoot,
        runId: run.runId,
        scope: "service",
        name: "ensureRuntime"
      },
      async () => {
        const storedRuntime = run.runtime ?? (await this.context.repositories.workflowRuns.readRuntime(run.runId));
        const initial = convergeWorkflowRuntime(run, storedRuntime);
        if (!initial.changed) {
          return initial.runtime;
        }
        return this.runWorkflowTransaction(run.runId, async () => {
          const freshRun = await this.loadRunOrThrow(run.runId);
          const freshStoredRuntime =
            freshRun.runtime ?? (await this.context.repositories.workflowRuns.readRuntime(freshRun.runId));
          const next = convergeWorkflowRuntime(freshRun, freshStoredRuntime);
          if (next.changed) {
            await this.context.repositories.workflowRuns.writeRuntime(freshRun.runId, next.runtime);
            await this.context.repositories.workflowRuns.patchRun(freshRun.runId, { runtime: next.runtime });
          }
          return next.runtime;
        });
      }
    );
  }

  buildSnapshot(run: WorkflowRunRecord, runtime: WorkflowRunRuntimeState): WorkflowRunRuntimeSnapshot {
    return buildWorkflowRuntimeSnapshot(
      run,
      runtime,
      run.status === "running" && this.context.activeRunIds.has(run.runId)
    );
  }
}
