import { randomUUID } from "node:crypto";
import { addPendingMessagesForRole, confirmPendingMessagesForRole } from "../../data/role-message-status-store.js";
import { getRuntimeSettings, type RuntimeSettings } from "../../data/runtime-settings-store.js";
import type { ProjectRepositoryBundle } from "../../data/repository/project-repository-bundle.js";
import type {
  ManagerToAgentMessage,
  ProjectPaths,
  ProjectRecord,
  SessionRecord,
  TaskRecord
} from "../../domain/models.js";
import {
  resolveSessionProviderId,
  type ProjectDispatchInput as ProviderProjectDispatchInput,
  type ProviderRegistry
} from "../provider-runtime.js";
import {
  markRunnerFatalError,
  markRunnerStarted,
  markRunnerSuccess,
  markRunnerTimeout
} from "../session-lifecycle-authority.js";
import type { DispatchKind, DispatchProjectInput, SessionDispatchResult } from "./project-orchestrator-types.js";
import { ProjectDispatchEventAdapter } from "./project-dispatch-event-adapter.js";
import {
  prepareProjectDispatchLaunch,
  type PreparedProjectDispatchLaunch,
  type ProjectDispatchProviderId
} from "./project-dispatch-launch-preparation.js";
import {
  buildProjectDispatchEventScope,
  buildProjectDispatchStartedDetails,
  appendProjectDispatchTerminalEventForContext,
  buildProjectDispatchProviderPayload,
  buildProjectDispatchRunnerScopePayload,
  buildProjectDispatchStartedScopeDetails,
  markProjectTaskDispatchedForContextIfNeeded
} from "./project-dispatch-launch-support.js";
import { runProjectDispatchProviderSession } from "./project-dispatch-provider-runner.js";
import {
  executeOrchestratorLaunch,
  type OrchestratorDispatchLaunchAdapter,
  type OrchestratorLaunchExecutionAdapter
} from "./shared/index.js";

export interface SyncDispatchRunResult {
  runId: string;
  finishedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  sessionId?: string;
  error?: string;
}

export interface ProjectDispatchLaunchContext {
  input: ProjectDispatchLaunchInput;
  providerId: ProjectDispatchProviderId;
  dispatchId: string;
  startedAt: string;
}

export interface ProjectDispatchLaunchInput {
  project: ProjectRecord;
  paths: ProjectPaths;
  session: SessionRecord;
  taskId: string;
  input: DispatchProjectInput;
  dispatchKind: DispatchKind;
  selectedMessageIds: string[];
  messages: ManagerToAgentMessage[];
  allTasks: TaskRecord[];
  firstMessage: ManagerToAgentMessage;
  activeTask: TaskRecord | null;
  rolePromptMap: Map<string, string>;
  roleSummaryMap: Map<string, string>;
  registeredAgentIds: string[];
}

export interface ProjectDispatchLaunchAdapterContext {
  dataRoot: string;
  providerRegistry: ProviderRegistry;
  repositories: ProjectRepositoryBundle;
  eventAdapter?: ProjectDispatchEventAdapter;
}

export interface ProjectDispatchLaunchOperations {
  now(): string;
  createDispatchId(): string;
  getRuntimeSettings(dataRoot: string): Promise<RuntimeSettings>;
  prepareProjectDispatchLaunch: typeof prepareProjectDispatchLaunch;
  addPendingMessagesForRole: typeof addPendingMessagesForRole;
  confirmPendingMessagesForRole: typeof confirmPendingMessagesForRole;
  markRunnerStarted: typeof markRunnerStarted;
  markRunnerSuccess: typeof markRunnerSuccess;
  markRunnerTimeout: typeof markRunnerTimeout;
  markRunnerFatalError: typeof markRunnerFatalError;
}

export interface ProjectDispatchLaunchExecutionHelpers {
  buildProviderDispatchPayload(
    context: ProjectDispatchLaunchContext,
    prepared: PreparedProjectDispatchLaunch,
    extra?: Partial<ProviderProjectDispatchInput>
  ): ProviderProjectDispatchInput;
  buildRunnerPayload(
    context: ProjectDispatchLaunchContext,
    runId?: string,
    sessionId?: string
  ): Parameters<ProjectDispatchLaunchOperations["markRunnerStarted"]>[0];
  appendTerminalDispatchEvent(
    context: ProjectDispatchLaunchContext,
    sessionId: string,
    details: {
      dispatchFailedReason: string | null;
      runId: string;
      exitCode: number | null;
      timedOut: boolean;
      finishedAt: string;
    }
  ): Promise<void>;
  markTaskDispatchedIfNeeded(context: ProjectDispatchLaunchContext): Promise<void>;
}

export interface ProjectDispatchLaunchExecutionDependencies {
  context: ProjectDispatchLaunchAdapterContext;
  operations: ProjectDispatchLaunchOperations;
  helpers: ProjectDispatchLaunchExecutionHelpers;
}

const defaultProjectDispatchLaunchOperations: ProjectDispatchLaunchOperations = {
  now: () => new Date().toISOString(),
  createDispatchId: () => randomUUID(),
  getRuntimeSettings,
  prepareProjectDispatchLaunch,
  addPendingMessagesForRole,
  confirmPendingMessagesForRole,
  markRunnerStarted,
  markRunnerSuccess,
  markRunnerTimeout,
  markRunnerFatalError
};

export class ProjectDispatchLaunchAdapter
  implements
    OrchestratorDispatchLaunchAdapter<ProjectDispatchLaunchInput, SessionDispatchResult>,
    OrchestratorLaunchExecutionAdapter<
      ProjectDispatchLaunchInput,
      ProjectDispatchLaunchContext,
      SessionDispatchResult,
      SessionDispatchResult
    >
{
  private readonly eventAdapter: ProjectDispatchEventAdapter;

  constructor(
    private readonly context: ProjectDispatchLaunchAdapterContext,
    private readonly operations: ProjectDispatchLaunchOperations = defaultProjectDispatchLaunchOperations
  ) {
    this.eventAdapter = context.eventAdapter ?? new ProjectDispatchEventAdapter(context.repositories);
  }

  async launch(input: ProjectDispatchLaunchInput): Promise<SessionDispatchResult> {
    return await executeOrchestratorLaunch(input, this);
  }

  async createContext(input: ProjectDispatchLaunchInput): Promise<ProjectDispatchLaunchContext> {
    const providerFromSession =
      input.session.provider === "codex" || input.session.provider === "trae" || input.session.provider === "minimax"
        ? input.session.provider
        : null;
    return {
      input,
      providerId: providerFromSession ?? resolveSessionProviderId(input.project, input.session.role, "minimax"),
      dispatchId: this.operations.createDispatchId(),
      startedAt: this.operations.now()
    };
  }

  async appendStarted(context: ProjectDispatchLaunchContext): Promise<void> {
    const { input } = context;
    await this.eventAdapter.appendStarted(
      buildProjectDispatchEventScope(input.project, input.paths, input.session.sessionId, input.taskId || undefined),
      buildProjectDispatchStartedDetails({
        dispatchId: context.dispatchId,
        dispatchKind: input.dispatchKind,
        requestId: input.firstMessage.envelope.correlation.request_id,
        mode: input.input.mode,
        messageIds: input.selectedMessageIds
      })
    );
  }

  async execute(context: ProjectDispatchLaunchContext): Promise<SessionDispatchResult> {
    const prepared = await this.operations.prepareProjectDispatchLaunch({
      dataRoot: this.context.dataRoot,
      project: context.input.project,
      paths: context.input.paths,
      session: context.input.session,
      providerId: context.providerId,
      taskId: context.input.taskId,
      messages: context.input.messages,
      allTasks: context.input.allTasks,
      rolePromptMap: context.input.rolePromptMap,
      roleSummaryMap: context.input.roleSummaryMap,
      registeredAgentIds: context.input.registeredAgentIds,
      startedAt: context.startedAt,
      dispatchId: context.dispatchId
    });
    return await runProjectDispatchProviderSession(this.buildExecutionDependencies(), context, prepared);
  }

  async onSuccess(
    _context: ProjectDispatchLaunchContext,
    result: SessionDispatchResult
  ): Promise<SessionDispatchResult> {
    return result;
  }

  async onFailure(context: ProjectDispatchLaunchContext, error: unknown): Promise<SessionDispatchResult> {
    const reason = error instanceof Error ? error.message : "Unknown error";
    if (reason.includes("role.md")) {
      await this.context.repositories.events.appendEvent(context.input.paths, {
        projectId: context.input.project.projectId,
        eventType: "AGENT_ROLE_TEMPLATE_MISSING",
        source: "manager",
        sessionId: context.input.session.sessionId,
        taskId: context.input.taskId,
        payload: {
          role: context.input.session.role,
          reason
        }
      });
    }
    await this.operations.markRunnerFatalError({
      dataRoot: this.context.dataRoot,
      project: context.input.project,
      paths: context.input.paths,
      sessionId: context.input.session.sessionId,
      taskId: context.input.taskId,
      messageId: context.input.dispatchKind === "message" ? context.input.firstMessage.envelope.message_id : undefined,
      dispatchId: context.dispatchId,
      provider: context.providerId,
      error: reason
    });
    await this.eventAdapter.appendFailed(
      buildProjectDispatchEventScope(
        context.input.project,
        context.input.paths,
        context.input.session.sessionId,
        context.input.taskId || undefined
      ),
      {
        ...this.buildStartedDetails(context),
        error: reason
      }
    );
    return {
      sessionId: context.input.session.sessionId,
      role: context.input.session.role,
      outcome: "dispatch_failed",
      dispatchKind: context.input.dispatchKind,
      reason,
      messageId: context.input.firstMessage.envelope.message_id,
      requestId: context.input.firstMessage.envelope.correlation.request_id,
      taskId: context.input.taskId
    };
  }

  private buildExecutionDependencies() {
    return {
      context: this.context,
      operations: this.operations,
      helpers: {
        buildProviderDispatchPayload: (
          context: ProjectDispatchLaunchContext,
          prepared: PreparedProjectDispatchLaunch,
          extra: Partial<ProviderProjectDispatchInput> = {}
        ) => buildProjectDispatchProviderPayload(context, prepared, extra),
        buildRunnerPayload: (context: ProjectDispatchLaunchContext, runId?: string, sessionId?: string) =>
          buildProjectDispatchRunnerScopePayload(this.context.dataRoot, context, runId, sessionId),
        appendTerminalDispatchEvent: (
          context: ProjectDispatchLaunchContext,
          sessionId: string,
          details: {
            dispatchFailedReason: string | null;
            runId: string;
            exitCode: number | null;
            timedOut: boolean;
            finishedAt: string;
          }
        ) => appendProjectDispatchTerminalEventForContext(this.eventAdapter, context, sessionId, details),
        markTaskDispatchedIfNeeded: (context: ProjectDispatchLaunchContext) =>
          markProjectTaskDispatchedForContextIfNeeded(this.context.repositories, context)
      }
    };
  }

  private buildStartedDetails(context: ProjectDispatchLaunchContext) {
    return buildProjectDispatchStartedScopeDetails(context);
  }
}
