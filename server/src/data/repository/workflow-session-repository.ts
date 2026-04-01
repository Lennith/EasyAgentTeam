import type { WorkflowSessionRecord } from "../../domain/models.js";
import {
  getWorkflowSession,
  listWorkflowSessions,
  touchWorkflowSession,
  upsertWorkflowSession
} from "../workflow-run-store.js";

export type UpsertWorkflowSessionInput = Parameters<typeof upsertWorkflowSession>[2];
export type TouchWorkflowSessionPatch = Parameters<typeof touchWorkflowSession>[3];

export interface WorkflowSessionRepository {
  listSessions(runId: string): Promise<WorkflowSessionRecord[]>;
  getSession(runId: string, sessionId: string): Promise<WorkflowSessionRecord | null>;
  upsertSession(
    runId: string,
    input: UpsertWorkflowSessionInput
  ): Promise<Awaited<ReturnType<typeof upsertWorkflowSession>>>;
  touchSession(runId: string, sessionId: string, patch: TouchWorkflowSessionPatch): Promise<WorkflowSessionRecord>;
}

class DefaultWorkflowSessionRepository implements WorkflowSessionRepository {
  constructor(private readonly dataRoot: string) {}

  listSessions(runId: string): Promise<WorkflowSessionRecord[]> {
    return listWorkflowSessions(this.dataRoot, runId);
  }

  getSession(runId: string, sessionId: string): Promise<WorkflowSessionRecord | null> {
    return getWorkflowSession(this.dataRoot, runId, sessionId);
  }

  upsertSession(runId: string, input: UpsertWorkflowSessionInput): Promise<Awaited<ReturnType<typeof upsertWorkflowSession>>> {
    return upsertWorkflowSession(this.dataRoot, runId, input);
  }

  touchSession(runId: string, sessionId: string, patch: TouchWorkflowSessionPatch): Promise<WorkflowSessionRecord> {
    return touchWorkflowSession(this.dataRoot, runId, sessionId, patch);
  }
}

export function createWorkflowSessionRepository(dataRoot: string): WorkflowSessionRepository {
  return new DefaultWorkflowSessionRepository(dataRoot);
}
