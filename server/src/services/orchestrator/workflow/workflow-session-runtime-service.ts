import type { ProviderRegistry } from "../../provider-runtime.js";
import type { WorkflowRunRecord, WorkflowSessionRecord } from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import { markWorkflowTimedOutSessions } from "./workflow-session-runtime-timeout.js";
import {
  loadWorkflowRunOrThrow,
  registerWorkflowRunSession,
  resolveWorkflowAuthoritativeSession,
  type WorkflowSessionAuthorityContext,
  type WorkflowSessionRegistrationInput
} from "./workflow-session-authority.js";

interface WorkflowSessionRuntimeContext extends WorkflowSessionAuthorityContext {
  dataRoot: string;
  sessionRunningTimeoutMs: number;
  sessionHeartbeatThrottle: Map<string, number>;
  buildRunSessionKey(runId: string, sessionId: string): string;
}

export class WorkflowSessionRuntimeService {
  constructor(private readonly context: WorkflowSessionRuntimeContext) {}

  private async loadRunOrThrow(runId: string): Promise<WorkflowRunRecord> {
    return await loadWorkflowRunOrThrow(this.context.repositories, runId);
  }

  async resolveAuthoritativeSession(
    runId: string,
    role: string,
    sessions: WorkflowSessionRecord[],
    runRecord?: WorkflowRunRecord,
    reason: string = "workflow_runtime"
  ): Promise<WorkflowSessionRecord | null> {
    return await resolveWorkflowAuthoritativeSession(this.context, {
      runId,
      role,
      sessions,
      runRecord,
      reason
    });
  }

  async touchSessionHeartbeat(runId: string, sessionId: string): Promise<void> {
    const key = this.context.buildRunSessionKey(runId, sessionId);
    const nowMs = Date.now();
    const last = this.context.sessionHeartbeatThrottle.get(key) ?? 0;
    if (nowMs - last < 1000) {
      return;
    }
    this.context.sessionHeartbeatThrottle.set(key, nowMs);
    await this.context.repositories.sessions.touchSession(runId, sessionId, {}).catch(() => {});
  }

  async listRunSessions(runId: string): Promise<{ runId: string; items: WorkflowSessionRecord[] }> {
    await this.loadRunOrThrow(runId);
    return { runId, items: await this.context.repositories.sessions.listSessions(runId) };
  }

  async registerRunSession(
    runId: string,
    input: WorkflowSessionRegistrationInput
  ): Promise<{ session: WorkflowSessionRecord; created: boolean }> {
    return await registerWorkflowRunSession(this.context, runId, input);
  }

  async markTimedOutSessions(run: WorkflowRunRecord, sessions: WorkflowSessionRecord[]): Promise<void> {
    await markWorkflowTimedOutSessions(
      {
        dataRoot: this.context.dataRoot,
        repositories: this.context.repositories,
        providerRegistry: this.context.providerRegistry,
        sessionRunningTimeoutMs: this.context.sessionRunningTimeoutMs,
        resolveAuthoritativeSession: (runId, role, candidateSessions, runRecord, reason) =>
          this.resolveAuthoritativeSession(runId, role, candidateSessions, runRecord, reason)
      },
      run,
      sessions
    );
  }
}
