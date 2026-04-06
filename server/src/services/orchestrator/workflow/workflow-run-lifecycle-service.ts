import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import type { WorkflowRunRecord, WorkflowRunRuntimeState } from "../../../domain/models.js";
import { resolveSessionProviderId, type ProviderRegistry } from "../../provider-runtime.js";
import { resolveOrchestratorProviderSessionId } from "../shared/orchestrator-runtime-helpers.js";
import type { WorkflowRunRuntimeStatus } from "./workflow-orchestrator-types.js";

interface WorkflowRunLifecycleServiceContext {
  repositories: WorkflowRepositoryBundle;
  providerRegistry: ProviderRegistry;
  activeRunIds: Set<string>;
  clearRunScopedState(runId: string): void;
  clearAutoFinishStableWindow(runId: string): void;
  loadRunOrThrow(runId: string): Promise<WorkflowRunRecord>;
  readConvergedRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState>;
  runWorkflowTransaction<T>(runId: string, operation: () => Promise<T>): Promise<T>;
}

export class WorkflowRunLifecycleService {
  constructor(private readonly context: WorkflowRunLifecycleServiceContext) {}

  async startRun(runId: string): Promise<WorkflowRunRuntimeStatus> {
    const run = await this.context.loadRunOrThrow(runId);
    const now = new Date().toISOString();
    let updated!: WorkflowRunRecord;
    await this.context.runWorkflowTransaction(runId, async () => {
      updated = await this.context.repositories.workflowRuns.patchRun(runId, {
        status: "running",
        startedAt: run.startedAt ?? now,
        stoppedAt: null,
        lastHeartbeatAt: now
      });
      const runtime = await this.context.readConvergedRuntime(updated);
      await this.context.repositories.workflowRuns.writeRuntime(runId, runtime);
    });
    this.context.activeRunIds.add(runId);
    this.context.clearAutoFinishStableWindow(runId);
    return {
      runId: updated.runId,
      status: updated.status,
      active: true,
      startedAt: updated.startedAt,
      stoppedAt: updated.stoppedAt,
      lastHeartbeatAt: updated.lastHeartbeatAt
    };
  }

  async stopRun(runId: string): Promise<WorkflowRunRuntimeStatus> {
    const run = await this.context.loadRunOrThrow(runId);
    if (run.status === "finished") {
      this.context.activeRunIds.delete(runId);
      return {
        runId: run.runId,
        status: run.status,
        active: false,
        startedAt: run.startedAt,
        stoppedAt: run.stoppedAt,
        lastHeartbeatAt: run.lastHeartbeatAt
      };
    }
    const sessions = await this.context.repositories.sessions.listSessions(runId);
    for (const session of sessions) {
      if (session.status !== "running") {
        continue;
      }
      const providerId = session.provider ?? resolveSessionProviderId(run, session.role, "minimax");
      const cancelSessionId = resolveOrchestratorProviderSessionId(session.sessionId, session.providerSessionId);
      const canceled = this.context.providerRegistry.cancelSession(providerId, cancelSessionId);
      await this.context.runWorkflowTransaction(runId, async () => {
        await this.context.repositories.sessions
          .touchSession(runId, session.sessionId, {
            status: "idle",
            currentTaskId: null,
            agentPid: null,
            cooldownUntil: null
          })
          .catch(() => {});
        await this.context.repositories.events.appendEvent(runId, {
          eventType: "RUN_STOP_SESSION_CANCEL",
          source: "system",
          sessionId: session.sessionId,
          payload: {
            provider: providerId,
            providerSessionId: cancelSessionId,
            canceled
          }
        });
      });
    }
    const now = new Date().toISOString();
    const updated = await this.context.runWorkflowTransaction(runId, async () =>
      this.context.repositories.workflowRuns.patchRun(runId, {
        status: "stopped",
        stoppedAt: now,
        lastHeartbeatAt: now
      })
    );
    this.context.activeRunIds.delete(runId);
    this.context.clearRunScopedState(runId);
    return {
      runId: updated.runId,
      status: updated.status,
      active: false,
      startedAt: updated.startedAt,
      stoppedAt: updated.stoppedAt,
      lastHeartbeatAt: updated.lastHeartbeatAt
    };
  }

  async getRunStatus(runId: string): Promise<WorkflowRunRuntimeStatus> {
    const run = await this.context.loadRunOrThrow(runId);
    return {
      runId: run.runId,
      status: run.status,
      active: run.status === "running" && this.context.activeRunIds.has(runId),
      startedAt: run.startedAt,
      stoppedAt: run.stoppedAt,
      lastHeartbeatAt: run.lastHeartbeatAt
    };
  }
}
