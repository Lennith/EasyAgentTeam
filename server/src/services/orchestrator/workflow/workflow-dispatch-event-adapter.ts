import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import type { OrchestratorDispatchLifecycleEventAdapter } from "../shared/contracts.js";
import { createOrchestratorDispatchLifecycleEventAdapter } from "../shared/dispatch-lifecycle.js";

interface WorkflowDispatchEventScope {
  runId: string;
  sessionId?: string;
  taskId?: string;
}

interface WorkflowDispatchStartedDetails {
  dispatchId: string;
  requestId: string;
  dispatchKind: "task" | "message";
  messageId?: string | null;
  requestedSkillIds?: string[];
  tokenLimit?: number;
  maxOutputTokens?: number;
}

interface WorkflowDispatchFinishedDetails extends WorkflowDispatchStartedDetails {
  finishReason?: string | null;
  usage?: unknown;
  exitCode?: number | null;
  timedOut?: boolean;
  synthetic?: boolean;
  reason?: string;
  maxTokensRecoveryAttempt?: number;
  maxTokensSnapshotPath?: string | null;
  recoveredFromMaxTokens?: boolean;
}

interface WorkflowDispatchFailedDetails extends WorkflowDispatchStartedDetails {
  error: string;
}

type WorkflowDispatchEventRecord = Parameters<WorkflowRepositoryBundle["events"]["appendEvent"]>[1];

export class WorkflowDispatchEventAdapter implements OrchestratorDispatchLifecycleEventAdapter<
  WorkflowDispatchEventScope,
  WorkflowDispatchStartedDetails,
  WorkflowDispatchFinishedDetails,
  WorkflowDispatchFailedDetails
> {
  private readonly adapter: OrchestratorDispatchLifecycleEventAdapter<
    WorkflowDispatchEventScope,
    WorkflowDispatchStartedDetails,
    WorkflowDispatchFinishedDetails,
    WorkflowDispatchFailedDetails
  >;

  constructor(private readonly repositories: WorkflowRepositoryBundle) {
    this.adapter = createOrchestratorDispatchLifecycleEventAdapter<
      WorkflowDispatchEventScope,
      WorkflowDispatchStartedDetails,
      WorkflowDispatchFinishedDetails,
      WorkflowDispatchFailedDetails,
      WorkflowDispatchEventRecord
    >({
      append: async (scope, event) => {
        await this.repositories.events.appendEvent(scope.runId, event);
      },
      buildEvent: (scope, eventType, payload) => ({
        eventType,
        source: "system",
        sessionId: scope.sessionId,
        taskId: scope.taskId,
        payload
      }),
      buildStartedPayload: (scope, details) => ({
        options: {
          requestId: details.requestId,
          dispatchId: details.dispatchId,
          dispatchKind: details.dispatchKind,
          messageId: details.messageId ?? null
        },
        extra: {
          runId: scope.runId,
          ...(details.requestedSkillIds ? { requestedSkillIds: details.requestedSkillIds } : {}),
          ...(typeof details.tokenLimit === "number" ? { tokenLimit: details.tokenLimit } : {}),
          ...(typeof details.maxOutputTokens === "number" ? { maxOutputTokens: details.maxOutputTokens } : {})
        }
      }),
      buildFinishedPayload: (scope, details) => ({
        options: {
          requestId: details.requestId,
          dispatchId: details.dispatchId,
          dispatchKind: details.dispatchKind,
          messageId: details.messageId ?? null
        },
        extra: {
          runId: scope.runId,
          ...(details.requestedSkillIds ? { requestedSkillIds: details.requestedSkillIds } : {}),
          ...(Object.prototype.hasOwnProperty.call(details, "finishReason")
            ? { finishReason: details.finishReason ?? null }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(details, "usage") ? { usage: details.usage ?? null } : {}),
          ...(Object.prototype.hasOwnProperty.call(details, "exitCode") ? { exitCode: details.exitCode ?? null } : {}),
          ...(Object.prototype.hasOwnProperty.call(details, "timedOut") ? { timedOut: details.timedOut ?? false } : {}),
          ...(details.synthetic ? { synthetic: true } : {}),
          ...(details.reason ? { reason: details.reason } : {}),
          ...(typeof details.tokenLimit === "number" ? { tokenLimit: details.tokenLimit } : {}),
          ...(typeof details.maxOutputTokens === "number" ? { maxOutputTokens: details.maxOutputTokens } : {}),
          ...(typeof details.maxTokensRecoveryAttempt === "number"
            ? { maxTokensRecoveryAttempt: details.maxTokensRecoveryAttempt }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(details, "maxTokensSnapshotPath")
            ? { maxTokensSnapshotPath: details.maxTokensSnapshotPath ?? null }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(details, "recoveredFromMaxTokens")
            ? { recoveredFromMaxTokens: details.recoveredFromMaxTokens ?? false }
            : {})
        }
      }),
      buildFailedPayload: (scope, details) => ({
        options: {
          requestId: details.requestId,
          dispatchId: details.dispatchId,
          dispatchKind: details.dispatchKind,
          messageId: details.messageId ?? null
        },
        extra: {
          runId: scope.runId,
          ...(details.requestedSkillIds ? { requestedSkillIds: details.requestedSkillIds } : {}),
          error: details.error
        }
      })
    });
  }

  async appendStarted(scope: WorkflowDispatchEventScope, details: WorkflowDispatchStartedDetails): Promise<void> {
    await this.adapter.appendStarted(scope, details);
  }

  async appendFinished(scope: WorkflowDispatchEventScope, details: WorkflowDispatchFinishedDetails): Promise<void> {
    await this.adapter.appendFinished(scope, details);
  }

  async appendFailed(scope: WorkflowDispatchEventScope, details: WorkflowDispatchFailedDetails): Promise<void> {
    await this.adapter.appendFailed(scope, details);
  }
}

export type {
  WorkflowDispatchEventScope,
  WorkflowDispatchFailedDetails,
  WorkflowDispatchFinishedDetails,
  WorkflowDispatchStartedDetails
};
