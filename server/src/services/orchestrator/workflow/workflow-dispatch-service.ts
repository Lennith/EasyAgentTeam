import type {
  WorkflowBlockReasonCode,
  WorkflowRunRecord,
  WorkflowRunRuntimeState,
  WorkflowSessionRecord,
  WorkflowTaskActionRequest,
  WorkflowTaskActionResult
} from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import { logger } from "../../../utils/logger.js";
import type { ProviderRegistry } from "../../provider-runtime.js";
import { resolveWorkflowRunRoleScope } from "../../workflow-role-scope-service.js";
import { collectWorkflowAncestorTaskIds, mergeWorkflowDependencies } from "./workflow-dispatch-policy.js";
import type { OrchestratorSingleFlightGate } from "../shared/kernel/single-flight.js";
import { WorkflowDispatchLaunchAdapter } from "./workflow-dispatch-launch-adapter.js";
import {
  buildWorkflowDispatchResult,
  createWorkflowDispatchLoopState,
  loadWorkflowRunOrThrow,
  runWorkflowDispatchLoop,
  type WorkflowDispatchLoopContext,
  type WorkflowDispatchLoopInput
} from "./workflow-dispatch-loop.js";
import {
  WorkflowMessageRoutingService,
  type WorkflowMessageRouteResult,
  type WorkflowRouteMessageInput
} from "./workflow-message-routing-service.js";
import { WorkflowDispatchSelectionAdapter } from "./workflow-dispatch-selection-adapter.js";
import type {
  WorkflowDispatchOutcome,
  WorkflowDispatchResult,
  WorkflowDispatchRow
} from "./workflow-dispatch-types.js";
import { resolveOrchestratorErrorMessage } from "../shared/index.js";
import { traceWorkflowPerfSpan } from "../../workflow-perf-trace.js";

interface WorkflowDispatchServiceContext extends WorkflowDispatchLoopContext {
  dataRoot: string;
  providerRegistry: ProviderRegistry;
  resolveAuthoritativeSession(
    runId: string,
    role: string,
    sessions: WorkflowSessionRecord[],
    runRecord?: WorkflowRunRecord,
    reason?: string
  ): Promise<WorkflowSessionRecord | null>;
  touchSessionHeartbeat(runId: string, sessionId: string): Promise<void>;
  createRuntimeError(
    message: string,
    code: string,
    status?: number,
    nextAction?: string,
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
  }

  private async loadRunOrThrow(runId: string): Promise<WorkflowRunRecord> {
    return await loadWorkflowRunOrThrow(this.context.repositories, this.context.createRuntimeError, runId);
  }

  private handleLaunchError(error: unknown): void {
    logger.error(`[workflow-dispatch-service] launch adapter failed: ${resolveOrchestratorErrorMessage(error)}`);
  }

  async sendRunMessage(input: WorkflowRouteMessageInput): Promise<WorkflowMessageRouteResult> {
    return await this.messageRoutingService.routeMessage(input);
  }

  async dispatchRun(runId: string, input: WorkflowDispatchLoopInput = {}): Promise<WorkflowDispatchResult> {
    return await traceWorkflowPerfSpan(
      {
        dataRoot: this.context.repositories.dataRoot,
        runId,
        scope: "service",
        name: "dispatchRun"
      },
      async () => {
        const { state, maxDispatches } = await createWorkflowDispatchLoopState(
          this.context,
          async (nextRunId) => await this.loadRunOrThrow(nextRunId),
          runId,
          input
        );
        const dispatchResult = await runWorkflowDispatchLoop(
          {
            context: this.context,
            launchAdapter: this.launchAdapter,
            selectionAdapter: this.selectionAdapter,
            loadRunOrThrow: async (nextRunId) => await this.loadRunOrThrow(nextRunId),
            handleLaunchError: (error) => {
              this.handleLaunchError(error);
            }
          },
          state,
          maxDispatches
        );
        return buildWorkflowDispatchResult(runId, state, dispatchResult);
      }
    );
  }
}

export { collectWorkflowAncestorTaskIds, mergeWorkflowDependencies, resolveWorkflowRunRoleScope };
export { hasWorkflowRoutePermission } from "./workflow-dispatch-policy.js";
export type { WorkflowBlockReasonCode, WorkflowDispatchOutcome, WorkflowDispatchResult, WorkflowDispatchRow };
