import type {
  WorkflowBlockReasonCode,
  WorkflowRunRecord,
  WorkflowRunRuntimeState,
  WorkflowSessionRecord,
  WorkflowTaskActionRequest,
  WorkflowTaskActionResult
} from "../../domain/models.js";
import { logger } from "../../utils/logger.js";
import type { ProviderRegistry } from "../provider-runtime.js";
import { resolveWorkflowRunRoleScope } from "../workflow-role-scope-service.js";
import { collectWorkflowAncestorTaskIds, mergeWorkflowDependencies } from "./workflow-dispatch-policy.js";
import type { OrchestratorSingleFlightGate } from "./kernel/single-flight.js";
import type { WorkflowRepositoryBundle } from "../../data/repository/workflow-repository-bundle.js";
import { WorkflowDispatchLaunchAdapter } from "./workflow-dispatch-launch-adapter.js";
import {
  type WorkflowDispatchLoopState,
  type WorkflowDispatchRow,
  WorkflowDispatchLoopPipeline
} from "./workflow-dispatch-loop-pipeline.js";
import {
  WorkflowMessageRoutingService,
  type WorkflowMessageRouteResult,
  type WorkflowRouteMessageInput
} from "./workflow-message-routing-service.js";
import { WorkflowDispatchSelectionAdapter } from "./workflow-dispatch-selection-adapter.js";
import { createTimestampedIdentifier } from "./shared/index.js";

export type WorkflowDispatchOutcome = WorkflowDispatchRow["outcome"];

export type { WorkflowDispatchRow };

export interface WorkflowDispatchResult {
  runId: string;
  results: Array<{
    role: string;
    sessionId: string | null;
    taskId: string | null;
    dispatchKind?: "task" | "message" | null;
    messageId?: string;
    requestId?: string;
    outcome: "dispatched" | "no_task" | "session_busy" | "run_not_running" | "invalid_target" | "already_dispatched";
    reason?: string;
  }>;
  dispatchedCount: number;
  remainingBudget: number;
}

interface WorkflowDispatchServiceContext {
  dataRoot: string;
  providerRegistry: ProviderRegistry;
  repositories: WorkflowRepositoryBundle;
  maxConcurrentDispatches: number;
  inFlightDispatchSessionKeys: OrchestratorSingleFlightGate;
  buildRunSessionKey(runId: string, sessionId: string): string;
  resolveAuthoritativeSession(
    runId: string,
    role: string,
    sessions: WorkflowSessionRecord[],
    runRecord?: WorkflowRunRecord,
    reason?: string
  ): Promise<WorkflowSessionRecord | null>;
  touchSessionHeartbeat(runId: string, sessionId: string): Promise<void>;
  ensureRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState>;
  readConvergedRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState>;
  createRuntimeError(
    message: string,
    code: string,
    status?: number,
    hint?: string,
    details?: Record<string, unknown>
  ): Error;
  applyTaskActions(
    runId: string,
    input: WorkflowTaskActionRequest
  ): Promise<Omit<WorkflowTaskActionResult, "requestId">>;
}

export class WorkflowDispatchService {
  private readonly launchAdapter: WorkflowDispatchLaunchAdapter;
  private readonly selectionAdapter: WorkflowDispatchSelectionAdapter;
  private readonly messageRoutingService: WorkflowMessageRoutingService;
  private readonly loopPipeline: WorkflowDispatchLoopPipeline;

  constructor(private readonly context: WorkflowDispatchServiceContext) {
    this.launchAdapter = new WorkflowDispatchLaunchAdapter({
      dataRoot: context.dataRoot,
      providerRegistry: context.providerRegistry,
      repositories: context.repositories,
      touchSessionHeartbeat: context.touchSessionHeartbeat,
      ensureRuntime: context.ensureRuntime,
      applyTaskActions: context.applyTaskActions,
      sendRunMessage: async (input) => await this.sendRunMessage(input)
    });
    this.selectionAdapter = new WorkflowDispatchSelectionAdapter({
      repositories: context.repositories,
      inFlightDispatchSessionKeys: context.inFlightDispatchSessionKeys,
      buildRunSessionKey: context.buildRunSessionKey,
      resolveAuthoritativeSession: context.resolveAuthoritativeSession
    });
    this.messageRoutingService = new WorkflowMessageRoutingService({
      repositories: context.repositories,
      loadRunOrThrow: async (runId) => await this.loadRunOrThrow(runId),
      resolveAuthoritativeSession: context.resolveAuthoritativeSession,
      createRuntimeError: context.createRuntimeError
    });
    this.loopPipeline = new WorkflowDispatchLoopPipeline({
      repositories: context.repositories,
      maxConcurrentDispatches: context.maxConcurrentDispatches,
      inFlightDispatchSessionKeys: context.inFlightDispatchSessionKeys,
      buildRunSessionKey: context.buildRunSessionKey,
      readConvergedRuntime: context.readConvergedRuntime,
      loadRunOrThrow: async (runId) => await this.loadRunOrThrow(runId),
      selectionAdapter: this.selectionAdapter,
      launchAdapter: this.launchAdapter,
      onLaunchError: (error) => this.handleLaunchError(error)
    });
  }

  private async loadRunOrThrow(runId: string): Promise<WorkflowRunRecord> {
    const run = await this.context.repositories.workflowRuns.getRun(runId);
    if (!run) {
      throw this.context.createRuntimeError(`run '${runId}' not found`, "RUN_NOT_FOUND", 404);
    }
    return run;
  }

  private handleLaunchError(error: unknown): void {
    logger.error(
      `[workflow-dispatch-service] launch adapter failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  async sendRunMessage(input: WorkflowRouteMessageInput): Promise<WorkflowMessageRouteResult> {
    return await this.messageRoutingService.routeMessage(input);
  }

  async dispatchRun(
    runId: string,
    input: {
      role?: string;
      taskId?: string;
      force?: boolean;
      onlyIdle?: boolean;
      maxDispatches?: number;
      source?: "manual" | "loop";
    } = {}
  ): Promise<WorkflowDispatchResult> {
    const run = await this.loadRunOrThrow(runId);
    const requestId = createTimestampedIdentifier("", 6);
    const maxDispatchesRaw = Number(input.maxDispatches ?? 1);
    const maxDispatches = Number.isFinite(maxDispatchesRaw) && maxDispatchesRaw > 0 ? Math.floor(maxDispatchesRaw) : 1;
    const state: WorkflowDispatchLoopState = {
      runId,
      run,
      runtime: await this.context.ensureRuntime(run),
      sessions: await this.context.repositories.sessions.listSessions(runId),
      role: input.role?.trim(),
      taskFilter: input.taskId?.trim(),
      force: Boolean(input.force),
      onlyIdle: Boolean(input.onlyIdle),
      requestId,
      source: input.source ?? "manual",
      remaining: Math.max(0, Math.floor(run.autoDispatchRemaining ?? 5))
    };
    const dispatchResult = await this.runLoop(state, maxDispatches);
    return {
      runId,
      results: dispatchResult.results,
      dispatchedCount: dispatchResult.dispatchedCount,
      remainingBudget: state.remaining
    };
  }

  private async runLoop(
    state: WorkflowDispatchLoopState,
    maxDispatches: number
  ): Promise<{
    results: WorkflowDispatchRow[];
    dispatchedCount: number;
  }> {
    return await this.loopPipeline.run(state, maxDispatches);
  }
}

export { collectWorkflowAncestorTaskIds, mergeWorkflowDependencies, resolveWorkflowRunRoleScope };
export { hasWorkflowRoutePermission } from "./workflow-dispatch-policy.js";
export type { WorkflowBlockReasonCode };
