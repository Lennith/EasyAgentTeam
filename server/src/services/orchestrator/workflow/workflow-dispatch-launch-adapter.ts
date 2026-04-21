import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import type {
  WorkflowManagerToAgentMessage,
  WorkflowRunRecord,
  WorkflowRunRuntimeState,
  WorkflowSessionRecord,
  WorkflowTaskActionRequest,
  WorkflowTaskActionResult
} from "../../../domain/models.js";
import type { ProviderRegistry } from "../../provider-runtime.js";
import type { WorkflowDispatchEventAdapter } from "./workflow-dispatch-event-adapter.js";
import type { WorkflowRouteMessageInput } from "./workflow-message-routing-service.js";
import {
  createWorkflowDispatchLaunchExecutionAdapter,
  defaultWorkflowDispatchLaunchPreparationOperations,
  type PreparedWorkflowDispatchLaunch,
  type WorkflowDispatchLaunchPreparationOperations
} from "./workflow-dispatch-launch-lifecycle.js";
import { createOrchestratorLaunchAdapter, type OrchestratorDispatchLaunchAdapter } from "../shared/index.js";

export interface WorkflowDispatchLaunchContext {
  input: WorkflowDispatchLaunchInput;
  prepared: PreparedWorkflowDispatchLaunch;
  lifecycleContext: {
    runId: string;
    sessionId: string;
    taskId: string | null;
    requestId: string;
    dispatchId: string;
    dispatchKind: "task" | "message";
    messageId?: string | null;
    requestedSkillIds: string[];
    tokenLimit: number;
    maxOutputTokens: number;
    providerSessionId: string;
    errorStreak: number;
  };
}

export interface WorkflowDispatchLaunchInput {
  run: WorkflowRunRecord;
  session: WorkflowSessionRecord;
  role: string;
  dispatchKind: "task" | "message";
  taskId: string | null;
  message: WorkflowManagerToAgentMessage | null;
  requestId: string;
  messageId?: string;
  dispatchId: string;
  recovery_attempt_id?: string;
}

export interface WorkflowDispatchLaunchAdapterContext {
  dataRoot: string;
  providerRegistry: ProviderRegistry;
  repositories: WorkflowRepositoryBundle;
  touchSessionHeartbeat(runId: string, sessionId: string): Promise<void>;
  ensureRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState>;
  applyTaskActions(
    runId: string,
    input: WorkflowTaskActionRequest
  ): Promise<Omit<WorkflowTaskActionResult, "requestId">>;
  sendRunMessage(input: WorkflowRouteMessageInput): Promise<unknown>;
  eventAdapter?: WorkflowDispatchEventAdapter;
}

export class WorkflowDispatchLaunchAdapter implements OrchestratorDispatchLaunchAdapter<
  WorkflowDispatchLaunchInput,
  void
> {
  private readonly launchAdapter: OrchestratorDispatchLaunchAdapter<WorkflowDispatchLaunchInput, void>;

  constructor(
    context: WorkflowDispatchLaunchAdapterContext,
    operations: WorkflowDispatchLaunchPreparationOperations = defaultWorkflowDispatchLaunchPreparationOperations
  ) {
    this.launchAdapter = createOrchestratorLaunchAdapter(
      createWorkflowDispatchLaunchExecutionAdapter(context, operations)
    );
  }

  async launch(input: WorkflowDispatchLaunchInput): Promise<void> {
    await this.launchAdapter.launch(input);
  }
}
