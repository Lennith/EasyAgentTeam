import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import { buildWorkflowRunStatusView } from "./workflow-runtime-view.js";
import type { WorkflowOrchestratorStatus } from "./workflow-orchestrator-types.js";

interface WorkflowLoopSnapshot {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  lastTickAt: string | null;
  started: boolean;
}

interface WorkflowOrchestratorStatusServiceContext {
  repositories: WorkflowRepositoryBundle;
  activeRunIds: Set<string>;
  maxConcurrentDispatches: number;
  getInFlightDispatchSessionCount(): number;
  getLoopSnapshot(): WorkflowLoopSnapshot;
}

export class WorkflowOrchestratorStatusService {
  constructor(private readonly context: WorkflowOrchestratorStatusServiceContext) {}

  async getStatus(): Promise<WorkflowOrchestratorStatus> {
    const loop = this.context.getLoopSnapshot();
    const activeRunIds = Array.from(this.context.activeRunIds).sort((a, b) => a.localeCompare(b));
    const runs = await this.context.repositories.workflowRuns.listRuns();
    return {
      enabled: loop.enabled,
      running: loop.running,
      intervalMs: loop.intervalMs,
      maxConcurrentDispatches: this.context.maxConcurrentDispatches,
      inFlightDispatchSessions: this.context.getInFlightDispatchSessionCount(),
      lastTickAt: loop.lastTickAt,
      started: loop.started,
      activeRunIds,
      activeRunCount: activeRunIds.length,
      runs: runs.map((item) => buildWorkflowRunStatusView(item))
    };
  }
}
