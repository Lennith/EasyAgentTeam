import {
  getWorkflowRepositoryBundle,
  type WorkflowRepositoryBundle
} from "../../../data/repository/workflow/repository-bundle.js";
import type { WorkflowBlockReasonCode } from "../../../domain/models.js";
import { logger } from "../../../utils/logger.js";
import { OrchestratorLoopCore } from "../../orchestrator-core.js";
import type { ProviderRegistry } from "../../provider-runtime.js";
import { WorkflowCompletionService } from "./workflow-completion-service.js";
import { WorkflowDispatchService } from "./workflow-dispatch-service.js";
import { OrchestratorKernel } from "../shared/kernel/orchestrator-kernel.js";
import { WorkflowOrchestratorStatusService } from "./workflow-orchestrator-status-service.js";
import type { ResolvedWorkflowOrchestratorOptions } from "./workflow-orchestrator-options.js";
import { WorkflowReminderService } from "./workflow-reminder-service.js";
import { WorkflowRunLifecycleService } from "./workflow-run-lifecycle-service.js";
import { WorkflowRunQueryService } from "./workflow-run-query-service.js";
import { WorkflowRuntimeSupportService } from "./workflow-runtime-support-service.js";
import { WorkflowSessionRuntimeService } from "./workflow-session-runtime-service.js";
import { WorkflowTaskActionService } from "./workflow-task-action-service.js";
import { WorkflowTickService } from "./workflow-tick-service.js";
import { createWorkflowOrchestratorTransientState } from "./workflow-orchestrator-state.js";
import { resolveOrchestratorErrorMessage } from "../shared/index.js";

export type WorkflowRuntimeErrorCode =
  | WorkflowBlockReasonCode
  | "ROUTE_DENIED"
  | "MESSAGE_TARGET_REQUIRED"
  | "TASK_OWNER_ROLE_NOT_FOUND"
  | "TASK_DEPENDENCY_NOT_READY"
  | "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN";

export interface WorkflowRuntimeErrorFactory {
  (
    message: string,
    code: WorkflowRuntimeErrorCode,
    status?: number,
    hint?: string,
    details?: Record<string, unknown>
  ): Error;
}

export interface WorkflowOrchestratorCompositionInput {
  dataRoot: string;
  options: ResolvedWorkflowOrchestratorOptions;
  providerRegistry: ProviderRegistry;
  createRuntimeError: WorkflowRuntimeErrorFactory;
}

export interface WorkflowOrchestratorComposition {
  loopCore: OrchestratorLoopCore;
  repositories: WorkflowRepositoryBundle;
  sessionRuntimeService: WorkflowSessionRuntimeService;
  dispatchService: WorkflowDispatchService;
  taskActionService: WorkflowTaskActionService;
  runLifecycleService: WorkflowRunLifecycleService;
  runQueryService: WorkflowRunQueryService;
  statusService: WorkflowOrchestratorStatusService;
  activeRunIds: Set<string>;
  clearAllTransientState(): void;
}

export function createWorkflowOrchestratorComposition(
  input: WorkflowOrchestratorCompositionInput
): WorkflowOrchestratorComposition {
  const kernel = new OrchestratorKernel();
  const repositories = getWorkflowRepositoryBundle(input.dataRoot);
  const transientState = createWorkflowOrchestratorTransientState();
  const {
    activeRunIds,
    inFlightDispatchSessionKeys,
    runHoldState,
    runAutoFinishStableTicks,
    sessionHeartbeatThrottle
  } = transientState;

  const runtimeSupportService = new WorkflowRuntimeSupportService({
    repositories,
    activeRunIds
  });
  const sessionRuntimeService = new WorkflowSessionRuntimeService({
    dataRoot: input.dataRoot,
    repositories,
    providerRegistry: input.providerRegistry,
    sessionRunningTimeoutMs: input.options.sessionRunningTimeoutMs,
    sessionHeartbeatThrottle,
    buildRunSessionKey: transientState.buildRunSessionKey
  });

  let dispatchService!: WorkflowDispatchService;
  const taskActionService = new WorkflowTaskActionService({
    repositories,
    loadRunOrThrow: (runId) => runtimeSupportService.loadRunOrThrow(runId),
    ensureRuntime: (run) => runtimeSupportService.ensureRuntime(run),
    readConvergedRuntime: (run) => runtimeSupportService.readConvergedRuntime(run),
    runWorkflowTransaction: (runId, operation) => runtimeSupportService.runWorkflowTransaction(runId, operation),
    sendRunMessage: (messageInput) => dispatchService.sendRunMessage(messageInput),
    buildSnapshot: (run, runtime) => runtimeSupportService.buildSnapshot(run, runtime),
    createRuntimeError: input.createRuntimeError
  });

  dispatchService = new WorkflowDispatchService({
    dataRoot: input.dataRoot,
    providerRegistry: input.providerRegistry,
    repositories,
    maxConcurrentDispatches: input.options.maxConcurrentDispatches,
    inFlightDispatchSessionKeys,
    buildRunSessionKey: transientState.buildRunSessionKey,
    resolveAuthoritativeSession: (runId, role, sessions, runRecord, reason) =>
      sessionRuntimeService.resolveAuthoritativeSession(runId, role, sessions, runRecord, reason),
    touchSessionHeartbeat: (runId, sessionId) => sessionRuntimeService.touchSessionHeartbeat(runId, sessionId),
    ensureRuntime: (run) => runtimeSupportService.ensureRuntime(run),
    readConvergedRuntime: (run) => runtimeSupportService.readConvergedRuntime(run),
    createRuntimeError: input.createRuntimeError,
    applyTaskActions: (runId, actionInput) => taskActionService.applyTaskActions(runId, actionInput)
  });

  const reminderService = new WorkflowReminderService({
    repositories,
    idleReminderMs: input.options.idleReminderMs,
    reminderBackoffMultiplier: input.options.reminderBackoffMultiplier,
    reminderMaxIntervalMs: input.options.reminderMaxIntervalMs,
    reminderMaxCount: input.options.reminderMaxCount,
    autoReminderEnabled: input.options.autoReminderEnabled,
    resolveAuthoritativeSession: (runId, role, sessions, runRecord, reason) =>
      sessionRuntimeService.resolveAuthoritativeSession(runId, role, sessions, runRecord, reason),
    dispatchRun: (runId, dispatchInput) => dispatchService.dispatchRun(runId, dispatchInput)
  });

  const completionService = new WorkflowCompletionService({
    repositories,
    runAutoFinishStableTicks,
    onRunFinished: (runId) => {
      activeRunIds.delete(runId);
      transientState.clearRunScopedState(runId);
    },
    loadRunOrThrow: (runId) => runtimeSupportService.loadRunOrThrow(runId),
    readConvergedRuntime: (run) => runtimeSupportService.readConvergedRuntime(run),
    runWorkflowTransaction: (runId, operation) => runtimeSupportService.runWorkflowTransaction(runId, operation)
  });

  const tickService = new WorkflowTickService({
    repositories,
    kernel,
    activeRunIds,
    runHoldState,
    pruneInactiveRunScopedState: (activeIds) => transientState.pruneInactiveRunScopedState(activeIds),
    ensureRuntime: (run) => runtimeSupportService.ensureRuntime(run),
    sessionRuntimeService,
    reminderService,
    completionService,
    dispatchService
  });

  const runLifecycleService = new WorkflowRunLifecycleService({
    repositories,
    providerRegistry: input.providerRegistry,
    activeRunIds,
    clearRunScopedState: (runId) => transientState.clearRunScopedState(runId),
    clearAutoFinishStableWindow: (runId) => {
      runAutoFinishStableTicks.delete(runId);
    },
    loadRunOrThrow: (runId) => runtimeSupportService.loadRunOrThrow(runId),
    readConvergedRuntime: (run) => runtimeSupportService.readConvergedRuntime(run),
    runWorkflowTransaction: (runId, operation) => runtimeSupportService.runWorkflowTransaction(runId, operation)
  });

  const runQueryService = new WorkflowRunQueryService({
    repositories,
    activeRunIds,
    loadRunOrThrow: (runId) => runtimeSupportService.loadRunOrThrow(runId),
    ensureRuntime: (run) => runtimeSupportService.ensureRuntime(run)
  });

  let loopCore!: OrchestratorLoopCore;
  const statusService = new WorkflowOrchestratorStatusService({
    repositories,
    activeRunIds,
    maxConcurrentDispatches: input.options.maxConcurrentDispatches,
    getInFlightDispatchSessionCount: () => inFlightDispatchSessionKeys.size,
    getLoopSnapshot: () => loopCore.getSnapshot()
  });

  loopCore = new OrchestratorLoopCore({
    enabled: input.options.enabled,
    intervalMs: input.options.intervalMs,
    onTick: async () => {
      await tickService.tickLoop();
    },
    onError: (error) => {
      logger.error(`[workflow-orchestrator] tickLoop failed: ${resolveOrchestratorErrorMessage(error)}`);
    }
  });

  return {
    loopCore,
    repositories,
    sessionRuntimeService,
    dispatchService,
    taskActionService,
    runLifecycleService,
    runQueryService,
    statusService,
    activeRunIds,
    clearAllTransientState: () => transientState.clearAllTransientState()
  };
}
