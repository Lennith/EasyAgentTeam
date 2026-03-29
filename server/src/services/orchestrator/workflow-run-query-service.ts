import type { WorkflowRepositoryBundle } from "../../data/repository/workflow-repository-bundle.js";
import type { ReminderMode, WorkflowRunRecord, WorkflowRunRuntimeState } from "../../domain/models.js";
import {
  buildWorkflowRunSettingsView,
  buildWorkflowRuntimeSnapshot,
  buildWorkflowTaskTreeView
} from "./workflow-runtime-view.js";
import type {
  WorkflowRunOrchestratorSettings,
  WorkflowTaskTreeRuntimeResponse
} from "./workflow-orchestrator-types.js";

interface WorkflowRunQueryServiceContext {
  repositories: WorkflowRepositoryBundle;
  activeRunIds: Set<string>;
  loadRunOrThrow(runId: string): Promise<WorkflowRunRecord>;
  ensureRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState>;
}

export class WorkflowRunQueryService {
  constructor(private readonly context: WorkflowRunQueryServiceContext) {}

  async getRunTaskRuntime(runId: string) {
    const run = await this.context.loadRunOrThrow(runId);
    const runtime = await this.context.ensureRuntime(run);
    return buildWorkflowRuntimeSnapshot(run, runtime, run.status === "running" && this.context.activeRunIds.has(runId));
  }

  async getRunTaskTreeRuntime(runId: string): Promise<WorkflowTaskTreeRuntimeResponse> {
    const run = await this.context.loadRunOrThrow(runId);
    const runtime = await this.context.ensureRuntime(run);
    const treeView = buildWorkflowTaskTreeView(run, runtime);
    return {
      run_id: run.runId,
      generated_at: new Date().toISOString(),
      status: run.status,
      active: run.status === "running" && this.context.activeRunIds.has(runId),
      roots: treeView.roots,
      nodes: treeView.nodes as WorkflowTaskTreeRuntimeResponse["nodes"],
      edges: treeView.edges,
      counters: treeView.counters
    };
  }

  async getRunOrchestratorSettings(runId: string): Promise<WorkflowRunOrchestratorSettings> {
    const run = await this.context.loadRunOrThrow(runId);
    return buildWorkflowRunSettingsView(run);
  }

  async patchRunOrchestratorSettings(
    runId: string,
    patch: {
      autoDispatchEnabled?: boolean;
      autoDispatchRemaining?: number;
      holdEnabled?: boolean;
      reminderMode?: ReminderMode;
    }
  ): Promise<WorkflowRunOrchestratorSettings> {
    const updated = await this.context.repositories.workflowRuns.patchRun(runId, patch);
    return buildWorkflowRunSettingsView(updated);
  }
}
