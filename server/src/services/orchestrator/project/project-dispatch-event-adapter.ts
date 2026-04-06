import type { ProjectPaths, ProjectRecord } from "../../../domain/models.js";
import type { ProjectRepositoryBundle } from "../../../data/repository/project/repository-bundle.js";
import type { DispatchKind, DispatchMode } from "./project-orchestrator-types.js";
import type { OrchestratorDispatchLifecycleEventAdapter } from "../shared/contracts.js";
import { createOrchestratorDispatchLifecycleEventAdapter } from "../shared/dispatch-lifecycle.js";

interface ProjectDispatchEventScope {
  project: ProjectRecord;
  paths: ProjectPaths;
  sessionId: string;
  taskId?: string;
}

interface ProjectDispatchStartedDetails {
  dispatchId: string;
  requestId: string;
  dispatchKind: DispatchKind;
  mode: DispatchMode;
  messageIds: string[];
}

interface ProjectDispatchFinishedDetails extends ProjectDispatchStartedDetails {
  runId: string;
  exitCode: number | null;
  timedOut: boolean;
  startedAt: string;
  finishedAt: string;
}

interface ProjectDispatchFailedDetails extends ProjectDispatchStartedDetails {
  error: string;
  runId?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  startedAt?: string;
  finishedAt?: string;
}

type ProjectDispatchEventRecord = Parameters<ProjectRepositoryBundle["events"]["appendEvent"]>[1];

export class ProjectDispatchEventAdapter implements OrchestratorDispatchLifecycleEventAdapter<
  ProjectDispatchEventScope,
  ProjectDispatchStartedDetails,
  ProjectDispatchFinishedDetails,
  ProjectDispatchFailedDetails
> {
  private readonly adapter: OrchestratorDispatchLifecycleEventAdapter<
    ProjectDispatchEventScope,
    ProjectDispatchStartedDetails,
    ProjectDispatchFinishedDetails,
    ProjectDispatchFailedDetails
  >;

  constructor(private readonly repositories: ProjectRepositoryBundle) {
    this.adapter = createOrchestratorDispatchLifecycleEventAdapter<
      ProjectDispatchEventScope,
      ProjectDispatchStartedDetails,
      ProjectDispatchFinishedDetails,
      ProjectDispatchFailedDetails,
      ProjectDispatchEventRecord
    >({
      append: async (scope, event) => {
        await this.repositories.events.appendEvent(scope.paths, event);
      },
      buildEvent: (scope, eventType, payload) => ({
        projectId: scope.project.projectId,
        eventType,
        source: "manager",
        sessionId: scope.sessionId,
        taskId: scope.taskId,
        payload
      }),
      buildStartedPayload: (_scope, details) => ({
        options: {
          dispatchId: details.dispatchId,
          dispatchKind: details.dispatchKind,
          requestId: details.requestId
        },
        extra: {
          mode: details.mode,
          messageIds: details.messageIds
        }
      }),
      buildFinishedPayload: (_scope, details) => ({
        options: {
          dispatchId: details.dispatchId,
          dispatchKind: details.dispatchKind,
          requestId: details.requestId
        },
        extra: {
          mode: details.mode,
          messageIds: details.messageIds,
          runId: details.runId,
          exitCode: details.exitCode,
          timedOut: details.timedOut,
          startedAt: details.startedAt,
          finishedAt: details.finishedAt
        }
      }),
      buildFailedPayload: (_scope, details) => ({
        options: {
          dispatchId: details.dispatchId,
          dispatchKind: details.dispatchKind,
          requestId: details.requestId
        },
        extra: {
          mode: details.mode,
          messageIds: details.messageIds,
          ...(details.runId ? { runId: details.runId } : {}),
          ...(Object.prototype.hasOwnProperty.call(details, "exitCode") ? { exitCode: details.exitCode ?? null } : {}),
          ...(Object.prototype.hasOwnProperty.call(details, "timedOut") ? { timedOut: details.timedOut ?? false } : {}),
          ...(details.startedAt ? { startedAt: details.startedAt } : {}),
          ...(details.finishedAt ? { finishedAt: details.finishedAt } : {}),
          error: details.error
        }
      })
    });
  }

  async appendStarted(scope: ProjectDispatchEventScope, details: ProjectDispatchStartedDetails): Promise<void> {
    await this.adapter.appendStarted(scope, details);
  }

  async appendFinished(scope: ProjectDispatchEventScope, details: ProjectDispatchFinishedDetails): Promise<void> {
    await this.adapter.appendFinished(scope, details);
  }

  async appendFailed(scope: ProjectDispatchEventScope, details: ProjectDispatchFailedDetails): Promise<void> {
    await this.adapter.appendFailed(scope, details);
  }
}

export type {
  ProjectDispatchEventScope,
  ProjectDispatchFinishedDetails,
  ProjectDispatchFailedDetails,
  ProjectDispatchStartedDetails
};
