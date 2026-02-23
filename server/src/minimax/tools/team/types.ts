import type { ProjectPaths, ProjectRecord } from "../../../domain/models.js";

export interface TeamToolExecutionContext {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  agentRole: string;
  sessionId: string;
  activeTaskId?: string;
  activeTaskTitle?: string;
  activeParentTaskId?: string;
  activeRootTaskId?: string;
  activeRequestId?: string;
  parentRequestId?: string;
}

export interface TeamToolBridge {
  taskAction(requestBody: Record<string, unknown>): Promise<Record<string, unknown>>;
  sendMessage(requestBody: Record<string, unknown>): Promise<Record<string, unknown>>;
  getRouteTargets(fromAgent: string): Promise<Record<string, unknown>>;
  lockAcquire(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  lockRenew(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  lockRelease(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  lockList(): Promise<Record<string, unknown>>;
}

export interface TeamToolErrorPayload {
  error_code: string;
  message: string;
  next_action: string | null;
  raw?: unknown;
}
