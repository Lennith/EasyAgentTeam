import type { ProjectPaths, ProjectRecord } from "../../../domain/models.js";
import type { ProjectRepositoryBundle } from "../../../data/repository/project/repository-bundle.js";
import type { ProviderRegistry } from "../../provider-runtime.js";
import type { OrchestratorSingleFlightGate } from "../shared/kernel/single-flight.js";

export type DispatchMode = "manual" | "loop";

export type DispatchOutcome =
  | "dispatched"
  | "no_message"
  | "message_not_found"
  | "task_not_found"
  | "task_not_force_dispatchable"
  | "task_already_done"
  | "task_owner_mismatch"
  | "already_dispatched"
  | "session_busy"
  | "session_not_found"
  | "dispatch_failed";

export type DispatchKind = "task" | "message" | null;

export interface SessionDispatchResult {
  sessionId: string;
  role: string;
  outcome: DispatchOutcome;
  dispatchKind: DispatchKind;
  reason?: string;
  messageId?: string;
  requestId?: string;
  runId?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  taskId?: string;
  sessionBootstrapped?: boolean;
  resolvedSessionId?: string;
}

export interface ProjectDispatchResult {
  projectId: string;
  mode: DispatchMode;
  results: SessionDispatchResult[];
}

export interface DispatchProjectInput {
  sessionId?: string;
  messageId?: string;
  taskId?: string;
  force?: boolean;
  onlyIdle?: boolean;
  maxDispatches?: number;
  mode: DispatchMode;
}

export interface OrchestratorOptions {
  dataRoot: string;
  providerRegistry: ProviderRegistry;
  enabled: boolean;
  intervalMs: number;
  maxConcurrentDispatches: number;
  sessionRunningTimeoutMs: number;
  idleTimeoutMs?: number;
  reminderBackoffMultiplier?: number;
  reminderMaxIntervalMs?: number;
  reminderMaxCount?: number;
  autoReminderEnabled?: boolean;
}

export type ReminderResetReason =
  | "session_created"
  | "session_dismissed"
  | "session_repaired"
  | "session_retry_dispatch_requested"
  | "force_dispatch_succeeded";

export interface ProjectDispatchContext {
  dataRoot: string;
  providerRegistry: ProviderRegistry;
  repositories: ProjectRepositoryBundle;
  inFlightDispatchSessionKeys: OrchestratorSingleFlightGate;
  buildSessionDispatchKey(projectId: string, sessionId: string): string;
  completionCleanup(paths: ProjectPaths, projectId: string, role: string): Promise<number>;
}

export interface ProjectSessionRuntimeContext {
  dataRoot: string;
  providerRegistry: ProviderRegistry;
  repositories: ProjectRepositoryBundle;
  sessionRunningTimeoutMs: number;
}

export interface ProjectReminderContext {
  dataRoot: string;
  repositories: ProjectRepositoryBundle;
  idleTimeoutMs?: number;
  reminderBackoffMultiplier?: number;
  reminderMaxIntervalMs?: number;
  reminderMaxCount?: number;
  autoReminderEnabled?: boolean;
  dispatchProject(
    projectId: string,
    input: Omit<DispatchProjectInput, "mode"> & { mode?: DispatchMode }
  ): Promise<ProjectDispatchResult>;
}

export interface ProjectCompletionContext {
  dataRoot: string;
  repositories: ProjectRepositoryBundle;
  lastObservabilityEventAt: Map<string, number>;
}

export interface ResolvedProjectContext {
  project: ProjectRecord;
  paths: ProjectPaths;
}
