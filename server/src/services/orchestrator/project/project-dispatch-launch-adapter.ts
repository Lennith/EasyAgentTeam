import type {
  addPendingMessagesForRole,
  confirmPendingMessagesForRole
} from "../../../data/repository/project/role-message-status-repository.js";
import type {
  getRuntimeSettings,
  RuntimeSettings
} from "../../../data/repository/system/runtime-settings-repository.js";
import type { ProjectRepositoryBundle } from "../../../data/repository/project/repository-bundle.js";
import type {
  ManagerToAgentMessage,
  ProjectPaths,
  ProjectRecord,
  SessionRecord,
  TaskRecord
} from "../../../domain/models.js";
import type { ProjectDispatchInput as ProviderProjectDispatchInput, ProviderRegistry } from "../../provider-runtime.js";
import type {
  markRunnerFatalError,
  markRunnerBlocked,
  markRunnerStarted,
  markRunnerSuccess,
  markRunnerTimeout
} from "../../session-lifecycle-authority.js";
import type { DispatchKind, DispatchProjectInput, SessionDispatchResult } from "./project-orchestrator-types.js";
import { ProjectDispatchEventAdapter } from "./project-dispatch-event-adapter.js";
import type {
  PreparedProjectDispatchLaunch,
  ProjectDispatchProviderId,
  prepareProjectDispatchLaunch
} from "./project-dispatch-launch-preparation.js";
import {
  createProjectDispatchLaunchExecutionAdapter,
  defaultProjectDispatchLaunchOperations
} from "./project-dispatch-launch-lifecycle.js";
import { createOrchestratorLaunchAdapter, type OrchestratorDispatchLaunchAdapter } from "../shared/index.js";

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
  markRunnerBlocked: typeof markRunnerBlocked;
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

export class ProjectDispatchLaunchAdapter implements OrchestratorDispatchLaunchAdapter<
  ProjectDispatchLaunchInput,
  SessionDispatchResult
> {
  private readonly launchAdapter: OrchestratorDispatchLaunchAdapter<ProjectDispatchLaunchInput, SessionDispatchResult>;

  constructor(
    context: ProjectDispatchLaunchAdapterContext,
    operations: ProjectDispatchLaunchOperations = defaultProjectDispatchLaunchOperations
  ) {
    const eventAdapter = context.eventAdapter ?? new ProjectDispatchEventAdapter(context.repositories);
    this.launchAdapter = createOrchestratorLaunchAdapter(
      createProjectDispatchLaunchExecutionAdapter(context, operations, eventAdapter)
    );
  }

  async launch(input: ProjectDispatchLaunchInput): Promise<SessionDispatchResult> {
    return await this.launchAdapter.launch(input);
  }
}
