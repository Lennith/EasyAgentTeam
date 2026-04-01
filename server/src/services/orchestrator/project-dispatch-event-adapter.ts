import type { ProjectPaths, ProjectRecord } from "../../domain/models.js";
import type { ProjectRepositoryBundle } from "../../data/repository/project-repository-bundle.js";
import type { DispatchKind, DispatchMode } from "./project-orchestrator-types.js";
import type { OrchestratorDispatchLifecycleEventAdapter } from "./shared/contracts.js";
import { buildOrchestratorDispatchPayload } from "./shared/dispatch-lifecycle.js";

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

export class ProjectDispatchEventAdapter implements OrchestratorDispatchLifecycleEventAdapter<
  ProjectDispatchEventScope,
  ProjectDispatchStartedDetails,
  ProjectDispatchFinishedDetails,
  ProjectDispatchFailedDetails
> {
  constructor(private readonly repositories: ProjectRepositoryBundle) {}

  async appendStarted(scope: ProjectDispatchEventScope, details: ProjectDispatchStartedDetails): Promise<void> {
    await this.repositories.events.appendEvent(scope.paths, {
      projectId: scope.project.projectId,
      eventType: "ORCHESTRATOR_DISPATCH_STARTED",
      source: "manager",
      sessionId: scope.sessionId,
      taskId: scope.taskId,
      payload: buildOrchestratorDispatchPayload(
        {
          dispatchId: details.dispatchId,
          dispatchKind: details.dispatchKind,
          requestId: details.requestId
        },
        {
          mode: details.mode,
          messageIds: details.messageIds
        }
      )
    });
  }

  async appendFinished(scope: ProjectDispatchEventScope, details: ProjectDispatchFinishedDetails): Promise<void> {
    await this.repositories.events.appendEvent(scope.paths, {
      projectId: scope.project.projectId,
      eventType: "ORCHESTRATOR_DISPATCH_FINISHED",
      source: "manager",
      sessionId: scope.sessionId,
      taskId: scope.taskId,
      payload: buildOrchestratorDispatchPayload(
        {
          dispatchId: details.dispatchId,
          dispatchKind: details.dispatchKind,
          requestId: details.requestId
        },
        {
          mode: details.mode,
          messageIds: details.messageIds,
          runId: details.runId,
          exitCode: details.exitCode,
          timedOut: details.timedOut,
          startedAt: details.startedAt,
          finishedAt: details.finishedAt
        }
      )
    });
  }

  async appendFailed(scope: ProjectDispatchEventScope, details: ProjectDispatchFailedDetails): Promise<void> {
    await this.repositories.events.appendEvent(scope.paths, {
      projectId: scope.project.projectId,
      eventType: "ORCHESTRATOR_DISPATCH_FAILED",
      source: "manager",
      sessionId: scope.sessionId,
      taskId: scope.taskId,
      payload: buildOrchestratorDispatchPayload(
        {
          dispatchId: details.dispatchId,
          dispatchKind: details.dispatchKind,
          requestId: details.requestId
        },
        {
          mode: details.mode,
          messageIds: details.messageIds,
          ...(details.runId ? { runId: details.runId } : {}),
          ...(Object.prototype.hasOwnProperty.call(details, "exitCode") ? { exitCode: details.exitCode ?? null } : {}),
          ...(Object.prototype.hasOwnProperty.call(details, "timedOut") ? { timedOut: details.timedOut ?? false } : {}),
          ...(details.startedAt ? { startedAt: details.startedAt } : {}),
          ...(details.finishedAt ? { finishedAt: details.finishedAt } : {}),
          error: details.error
        }
      )
    });
  }
}

export type {
  ProjectDispatchEventScope,
  ProjectDispatchFinishedDetails,
  ProjectDispatchFailedDetails,
  ProjectDispatchStartedDetails
};
