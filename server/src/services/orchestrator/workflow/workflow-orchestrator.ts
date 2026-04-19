import type {
  WorkflowBlockReasonCode,
  ReminderMode,
  WorkflowRunMode,
  WorkflowManagerToAgentMessage,
  WorkflowRunRecord,
  WorkflowSessionRecord,
  WorkflowTaskActionRequest,
  WorkflowTaskActionResult,
  WorkflowTaskRuntimeRecord,
  WorkflowTaskState
} from "../../../domain/models.js";
import { type ProviderRegistry } from "../../provider-runtime.js";
import { buildWorkflowDispatchPrompt } from "./workflow-dispatch-prompt.js";
import { buildWorkflowDispatchPromptContext } from "./workflow-dispatch-prompt-context.js";
import {
  createWorkflowOrchestratorComposition,
  type WorkflowRuntimeErrorCode
} from "./workflow-orchestrator-composition.js";
import {
  resolveWorkflowOrchestratorOptionsFromEnv,
  type ResolvedWorkflowOrchestratorOptions
} from "./workflow-orchestrator-options.js";
import type { WorkflowMessageRouteResult, WorkflowRouteMessageInput } from "./workflow-message-routing-service.js";
import type {
  WorkflowDispatchResult,
  WorkflowOrchestratorStatus,
  WorkflowRunOrchestratorSettings,
  WorkflowRunRuntimeStatus,
  WorkflowTaskTreeRuntimeResponse
} from "./workflow-orchestrator-types.js";

export type {
  WorkflowDispatchResult,
  WorkflowOrchestratorStatus,
  WorkflowRunOrchestratorSettings,
  WorkflowRunRuntimeStatus,
  WorkflowTaskTreeRuntimeResponse
} from "./workflow-orchestrator-types.js";

export class WorkflowRuntimeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | WorkflowBlockReasonCode
      | "ROUTE_DENIED"
      | "MESSAGE_TARGET_REQUIRED"
      | "TASK_OWNER_ROLE_NOT_FOUND"
      | "TASK_DEPENDENCY_NOT_READY"
      | "TASK_EXISTS"
      | "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN",
    public readonly status: number = 400,
    public readonly nextAction?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export class WorkflowOrchestratorService {
  private readonly loopCore;
  private readonly activeRunIds;
  private readonly reminderService;
  private readonly sessionRuntimeService;
  private readonly dispatchService;
  private readonly taskActionService;
  private readonly runLifecycleService;
  private readonly runQueryService;
  private readonly statusService;
  private readonly clearAllTransientState: () => void;

  constructor(dataRoot: string, options: ResolvedWorkflowOrchestratorOptions, providerRegistry: ProviderRegistry) {
    const composition = createWorkflowOrchestratorComposition({
      dataRoot,
      options,
      providerRegistry,
      createRuntimeError: (message, code, status = 400, nextAction, details) =>
        new WorkflowRuntimeError(message, code as WorkflowRuntimeErrorCode, status, nextAction, details)
    });
    this.loopCore = composition.loopCore;
    this.activeRunIds = composition.activeRunIds;
    this.reminderService = composition.reminderService;
    this.sessionRuntimeService = composition.sessionRuntimeService;
    this.dispatchService = composition.dispatchService;
    this.taskActionService = composition.taskActionService;
    this.runLifecycleService = composition.runLifecycleService;
    this.runQueryService = composition.runQueryService;
    this.statusService = composition.statusService;
    this.clearAllTransientState = composition.clearAllTransientState;
  }

  start(): void {
    this.loopCore.start();
  }

  stop(): void {
    this.loopCore.stop();
    this.activeRunIds.clear();
    this.clearAllTransientState();
  }

  // Compatibility seam: internal tests and legacy orchestrator glue still call this helper directly.
  private buildDispatchPrompt(input: {
    run: WorkflowRunRecord;
    role: string;
    taskId: string | null;
    dispatchKind: "task" | "message";
    message: WorkflowManagerToAgentMessage | null;
    taskState: WorkflowTaskState | null;
    runtimeTasks: WorkflowTaskRuntimeRecord[];
    rolePrompt?: string;
  }): string {
    return buildWorkflowDispatchPrompt(buildWorkflowDispatchPromptContext(input));
  }

  // Compatibility seam: timeout-recovery tests and legacy codepaths call this through service instance.
  private async markTimedOutSessions(run: WorkflowRunRecord, sessions: WorkflowSessionRecord[]): Promise<void> {
    return this.sessionRuntimeService.markTimedOutSessions(run, sessions);
  }

  async startRun(runId: string): Promise<WorkflowRunRuntimeStatus> {
    return this.runLifecycleService.startRun(runId);
  }

  async stopRun(runId: string): Promise<WorkflowRunRuntimeStatus> {
    return this.runLifecycleService.stopRun(runId);
  }

  async getRunStatus(runId: string): Promise<WorkflowRunRuntimeStatus> {
    return this.runLifecycleService.getRunStatus(runId);
  }

  async getRunTaskRuntime(runId: string) {
    return this.runQueryService.getRunTaskRuntime(runId);
  }

  async getRunTaskTreeRuntime(runId: string): Promise<WorkflowTaskTreeRuntimeResponse> {
    return this.runQueryService.getRunTaskTreeRuntime(runId);
  }

  async listRunSessions(runId: string): Promise<{ runId: string; items: WorkflowSessionRecord[] }> {
    return this.sessionRuntimeService.listRunSessions(runId);
  }

  async registerRunSession(
    runId: string,
    input: {
      role: string;
      sessionId?: string;
      status?: string;
      providerSessionId?: string;
      provider?: "codex" | "minimax";
    }
  ): Promise<{ session: WorkflowSessionRecord; created: boolean }> {
    return this.sessionRuntimeService.registerRunSession(runId, input);
  }

  dismissRunSession(runId: string, sessionId: string, reason: string) {
    return this.sessionRuntimeService.dismissSession(runId, sessionId, reason);
  }

  repairRunSessionStatus(runId: string, sessionId: string, targetStatus: "idle" | "blocked", reason: string) {
    return this.sessionRuntimeService.repairSessionStatus(runId, sessionId, targetStatus, reason);
  }

  resetRoleReminderOnManualAction(
    runId: string,
    role: string,
    reason: "session_created" | "session_dismissed" | "session_repaired"
  ) {
    return this.reminderService.resetRoleReminderOnManualAction(runId, role, reason);
  }

  async sendRunMessage(input: WorkflowRouteMessageInput): Promise<WorkflowMessageRouteResult> {
    return this.dispatchService.sendRunMessage(input);
  }

  async applyTaskActions(
    runId: string,
    input: WorkflowTaskActionRequest
  ): Promise<Omit<WorkflowTaskActionResult, "requestId">> {
    return this.taskActionService.applyTaskActions(runId, input);
  }

  async getRunOrchestratorSettings(runId: string): Promise<WorkflowRunOrchestratorSettings> {
    return this.runQueryService.getRunOrchestratorSettings(runId);
  }

  async patchRunOrchestratorSettings(
    runId: string,
    patch: {
      autoDispatchEnabled?: boolean;
      autoDispatchRemaining?: number;
      holdEnabled?: boolean;
      reminderMode?: ReminderMode;
      mode?: WorkflowRunMode;
      loopEnabled?: boolean;
      scheduleEnabled?: boolean;
      scheduleExpression?: string | null;
      isScheduleSeed?: boolean;
    }
  ): Promise<WorkflowRunOrchestratorSettings> {
    return this.runQueryService.patchRunOrchestratorSettings(runId, patch);
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
    return this.dispatchService.dispatchRun(runId, input);
  }

  async getStatus(): Promise<WorkflowOrchestratorStatus> {
    return this.statusService.getStatus();
  }
}

export function createWorkflowOrchestratorService(
  dataRoot: string,
  providerRegistry: ProviderRegistry
): WorkflowOrchestratorService {
  return new WorkflowOrchestratorService(dataRoot, resolveWorkflowOrchestratorOptionsFromEnv(), providerRegistry);
}
