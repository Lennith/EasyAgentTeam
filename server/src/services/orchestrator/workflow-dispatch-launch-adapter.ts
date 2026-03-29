import type { WorkflowRepositoryBundle } from "../../data/repository/workflow-repository-bundle.js";
import type {
  WorkflowManagerToAgentMessage,
  WorkflowRunRecord,
  WorkflowRunRuntimeState,
  WorkflowSessionRecord,
  WorkflowTaskActionRequest,
  WorkflowTaskActionResult
} from "../../domain/models.js";
import type { ProviderRegistry } from "../provider-runtime.js";
import { buildWorkflowDispatchPrompt } from "./workflow-dispatch-prompt.js";
import { buildWorkflowDispatchPromptContext } from "./workflow-dispatch-prompt-context.js";
import { WorkflowDispatchEventAdapter } from "./workflow-dispatch-event-adapter.js";
import {
  defaultWorkflowDispatchLaunchPreparationOperations,
  prepareWorkflowDispatchLaunch,
  type PreparedWorkflowDispatchLaunch,
  type WorkflowDispatchLaunchPreparationOperations
} from "./workflow-dispatch-launch-preparation.js";
import {
  handleMissingWorkflowMiniMaxConfiguration,
  handleWorkflowDispatchLaunchError,
  handleWorkflowDispatchLaunchResult,
  runWorkflowDispatchProviderSession,
  type WorkflowDispatchLifecycleContext
} from "./workflow-dispatch-provider-runner.js";
import {
  resolveOrchestratorProviderSessionId,
  executeOrchestratorLaunch,
  type OrchestratorDispatchLaunchAdapter,
  type OrchestratorLaunchExecutionAdapter
} from "./shared/index.js";

type WorkflowLaunchMessageType =
  | "MANAGER_MESSAGE"
  | "TASK_DISCUSS_REQUEST"
  | "TASK_DISCUSS_REPLY"
  | "TASK_DISCUSS_CLOSED";

class WorkflowDispatchConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowDispatchConfigurationError";
  }
}

export interface WorkflowDispatchLaunchContext {
  input: WorkflowDispatchLaunchInput;
  prepared: PreparedWorkflowDispatchLaunch;
  lifecycleContext: WorkflowDispatchLifecycleContext;
}

export interface WorkflowDispatchLaunchMessageInput {
  runId: string;
  fromAgent: string;
  fromSessionId: string;
  messageType: WorkflowLaunchMessageType;
  toRole?: string;
  toSessionId?: string;
  taskId?: string;
  content: string;
  requestId?: string;
  parentRequestId?: string;
  discuss?: { threadId?: string; requestId?: string };
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
  sendRunMessage(input: WorkflowDispatchLaunchMessageInput): Promise<unknown>;
  eventAdapter?: WorkflowDispatchEventAdapter;
}

export class WorkflowDispatchLaunchAdapter
  implements
    OrchestratorDispatchLaunchAdapter<WorkflowDispatchLaunchInput, void>,
    OrchestratorLaunchExecutionAdapter<
      WorkflowDispatchLaunchInput,
      WorkflowDispatchLaunchContext,
      Awaited<ReturnType<ProviderRegistry["runSessionWithTools"]>>,
      void
    >
{
  private readonly eventAdapter: WorkflowDispatchEventAdapter;

  constructor(
    private readonly context: WorkflowDispatchLaunchAdapterContext,
    private readonly operations: WorkflowDispatchLaunchPreparationOperations = defaultWorkflowDispatchLaunchPreparationOperations
  ) {
    this.eventAdapter = context.eventAdapter ?? new WorkflowDispatchEventAdapter(context.repositories);
  }

  async launch(input: WorkflowDispatchLaunchInput): Promise<void> {
    await executeOrchestratorLaunch(input, this);
  }

  async createContext(input: WorkflowDispatchLaunchInput): Promise<WorkflowDispatchLaunchContext> {
    const prepared = await prepareWorkflowDispatchLaunch(
      {
        dataRoot: this.context.dataRoot,
        run: input.run,
        role: input.role,
        session: input.session
      },
      this.operations
    );
    return {
      input,
      prepared,
      lifecycleContext: {
        runId: input.run.runId,
        sessionId: input.session.sessionId,
        taskId: input.taskId,
        requestId: input.requestId,
        dispatchId: input.dispatchId,
        dispatchKind: input.dispatchKind,
        messageId: input.messageId ?? null,
        requestedSkillIds: prepared.requestedSkillIds,
        tokenLimit: prepared.tokenLimit,
        maxOutputTokens: prepared.maxOutputTokens,
        providerSessionId: resolveOrchestratorProviderSessionId(
          input.session.sessionId,
          input.session.providerSessionId
        ),
        errorStreak: input.session.errorStreak ?? 0
      }
    };
  }

  async appendStarted(context: WorkflowDispatchLaunchContext): Promise<void> {
    await this.eventAdapter.appendStarted(
      {
        runId: context.lifecycleContext.runId,
        sessionId: context.lifecycleContext.sessionId,
        taskId: context.lifecycleContext.taskId ?? undefined
      },
      {
        requestId: context.lifecycleContext.requestId,
        dispatchId: context.lifecycleContext.dispatchId,
        dispatchKind: context.lifecycleContext.dispatchKind,
        messageId: context.lifecycleContext.messageId ?? null,
        requestedSkillIds: context.lifecycleContext.requestedSkillIds,
        tokenLimit: context.lifecycleContext.tokenLimit,
        maxOutputTokens: context.lifecycleContext.maxOutputTokens
      }
    );
  }

  async execute(context: WorkflowDispatchLaunchContext) {
    if (context.prepared.providerId === "minimax" && !context.prepared.settings.minimaxApiKey) {
      throw new WorkflowDispatchConfigurationError("minimax_not_configured");
    }
    const runtime = await this.context.ensureRuntime(context.input.run);
    const runtimeTask = context.input.taskId
      ? (runtime.tasks.find((item) => item.taskId === context.input.taskId) ?? null)
      : null;
    const promptContext = buildWorkflowDispatchPromptContext({
      run: context.input.run,
      role: context.input.role,
      taskId: context.input.taskId,
      dispatchKind: context.input.dispatchKind,
      message: context.input.message,
      taskState: runtimeTask?.state ?? null,
      runtimeTasks: runtime.tasks,
      rolePrompt: context.prepared.rolePrompt
    });
    const prompt = buildWorkflowDispatchPrompt(promptContext);
    return await runWorkflowDispatchProviderSession(this.context, context, prompt);
  }

  async onSuccess(
    context: WorkflowDispatchLaunchContext,
    dispatchRunResult: Awaited<ReturnType<ProviderRegistry["runSessionWithTools"]>>
  ): Promise<void> {
    await handleWorkflowDispatchLaunchResult(
      {
        repositories: this.context.repositories,
        eventAdapter: this.eventAdapter
      },
      context.lifecycleContext,
      dispatchRunResult
    );
  }

  async onFailure(context: WorkflowDispatchLaunchContext, error: unknown): Promise<void> {
    if (error instanceof WorkflowDispatchConfigurationError && error.message === "minimax_not_configured") {
      await handleMissingWorkflowMiniMaxConfiguration(
        {
          repositories: this.context.repositories,
          eventAdapter: this.eventAdapter
        },
        context.lifecycleContext
      );
      return;
    }
    await handleWorkflowDispatchLaunchError(
      {
        repositories: this.context.repositories,
        eventAdapter: this.eventAdapter
      },
      context.lifecycleContext,
      error
    );
  }
}
