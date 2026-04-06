import { appendEvent } from "../data/repository/project/event-repository.js";
import {
  getProject,
  getProjectOverview,
  getProjectPaths,
  listProjects,
  updateProjectOrchestratorSettings,
  updateProjectRouting,
  updateTaskAssignRouting
} from "../data/repository/project/runtime-repository.js";
import { ProjectStoreError } from "../data/repository/project/runtime-repository.js";
import {
  getProjectRepositoryBundle,
  type ProjectRepositoryBundle
} from "../data/repository/project/repository-bundle.js";
import type { SessionRecord } from "../domain/models.js";
import { listAgents } from "../data/repository/catalog/agent-repository.js";
import { getTeam } from "../data/repository/catalog/team-repository.js";
import { resolveOrchestratorProviderSessionId } from "./orchestrator/shared/orchestrator-runtime-helpers.js";
import type { SessionProcessTerminationResult } from "./orchestrator/project/project-session-runtime-service.js";
import type { ProviderRegistry } from "./provider-runtime.js";

const DEFAULT_PROJECT_DELETE_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_PROJECT_DELETE_POLL_INTERVAL_MS = 100;

interface ProjectDeleteRuntimeController {
  orchestrator: {
    terminateSessionProcess(
      projectId: string,
      sessionId: string,
      reason: string
    ): Promise<SessionProcessTerminationResult>;
  };
  providerRegistry: Pick<ProviderRegistry, "isSessionActive">;
  repositories?: ProjectRepositoryBundle;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  drainTimeoutMs?: number;
  pollIntervalMs?: number;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readDeleteDrainTimeoutMs(override?: number): number {
  const raw =
    override ?? Number(process.env.PROJECT_DELETE_DRAIN_TIMEOUT_MS ?? DEFAULT_PROJECT_DELETE_DRAIN_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_PROJECT_DELETE_DRAIN_TIMEOUT_MS;
  }
  return Math.floor(raw);
}

function readDeletePollIntervalMs(override?: number): number {
  const raw =
    override ?? Number(process.env.PROJECT_DELETE_POLL_INTERVAL_MS ?? DEFAULT_PROJECT_DELETE_POLL_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_PROJECT_DELETE_POLL_INTERVAL_MS;
  }
  return Math.floor(raw);
}

function isProjectSessionProviderActive(
  session: SessionRecord,
  providerRegistry: Pick<ProviderRegistry, "isSessionActive">
): boolean {
  const providerSessionId = resolveOrchestratorProviderSessionId(session.sessionId, session.providerSessionId);
  try {
    return providerRegistry.isSessionActive(session.provider, providerSessionId);
  } catch {
    return false;
  }
}

function shouldTerminateProjectSession(
  session: SessionRecord,
  providerRegistry: Pick<ProviderRegistry, "isSessionActive">
): boolean {
  if (session.status === "running") {
    return true;
  }
  if (typeof session.agentPid === "number" && Number.isFinite(session.agentPid) && session.agentPid > 0) {
    return true;
  }
  if (session.status !== "dismissed" && session.lastRunId) {
    return true;
  }
  return isProjectSessionProviderActive(session, providerRegistry);
}

function listBusyProjectSessions(
  sessions: SessionRecord[],
  providerRegistry: Pick<ProviderRegistry, "isSessionActive">
): string[] {
  return sessions
    .filter((session) => isProjectSessionProviderActive(session, providerRegistry))
    .map((session) => resolveOrchestratorProviderSessionId(session.sessionId, session.providerSessionId));
}

async function drainProjectRuntimeBeforeDelete(
  dataRoot: string,
  projectId: string,
  runtime: ProjectDeleteRuntimeController
): Promise<ProjectRepositoryBundle> {
  const repositories = runtime.repositories ?? getProjectRepositoryBundle(dataRoot);
  const scope = await repositories.resolveScope(projectId);
  const sessions = await repositories.sessions.listSessions(scope.paths, scope.project.projectId);
  const drainCandidates = sessions.filter((session) =>
    shouldTerminateProjectSession(session, runtime.providerRegistry)
  );

  for (const session of drainCandidates) {
    const outcome = await runtime.orchestrator.terminateSessionProcess(
      scope.project.projectId,
      session.sessionId,
      "project_delete"
    );
    if (outcome.result === "failed" || outcome.result === "access_denied") {
      throw new ProjectStoreError(
        `project '${scope.project.projectId}' runtime still active for session '${session.sessionId}': ${outcome.message}`,
        "PROJECT_RUNTIME_BUSY"
      );
    }
  }

  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? sleepMs;
  const deadline = now() + readDeleteDrainTimeoutMs(runtime.drainTimeoutMs);
  const pollIntervalMs = readDeletePollIntervalMs(runtime.pollIntervalMs);
  let busySessions = listBusyProjectSessions(sessions, runtime.providerRegistry);
  while (busySessions.length > 0) {
    if (now() >= deadline) {
      throw new ProjectStoreError(
        `project '${scope.project.projectId}' runtime still active after drain timeout: ${busySessions.join(", ")}`,
        "PROJECT_RUNTIME_BUSY"
      );
    }
    await sleep(pollIntervalMs);
    busySessions = listBusyProjectSessions(sessions, runtime.providerRegistry);
  }

  return repositories;
}

export async function listProjectSummaries(dataRoot: string) {
  return listProjects(dataRoot);
}

export async function readProject(dataRoot: string, projectId: string) {
  return getProject(dataRoot, projectId);
}

export async function readProjectOverview(dataRoot: string, projectId: string) {
  return getProjectOverview(dataRoot, projectId);
}

export function getProjectPathsForId(dataRoot: string, projectId: string) {
  return getProjectPaths(dataRoot, projectId);
}

export async function updateProjectRoutingConfig(
  dataRoot: string,
  projectId: string,
  input: Parameters<typeof updateProjectRouting>[2]
) {
  return updateProjectRouting(dataRoot, projectId, input);
}

export async function updateProjectTaskAssignRouting(
  dataRoot: string,
  projectId: string,
  taskAssignRouteTable: Record<string, string[]>
) {
  return updateTaskAssignRouting(dataRoot, projectId, taskAssignRouteTable);
}

export async function updateProjectOrchestratorConfig(
  dataRoot: string,
  projectId: string,
  input: Parameters<typeof updateProjectOrchestratorSettings>[2]
) {
  return updateProjectOrchestratorSettings(dataRoot, projectId, input);
}

export async function deleteProjectById(dataRoot: string, projectId: string, runtime: ProjectDeleteRuntimeController) {
  const repositories = await drainProjectRuntimeBeforeDelete(dataRoot, projectId, runtime);
  return repositories.projectRuntime.deleteProject(projectId);
}

export async function listRegisteredAgents(dataRoot: string) {
  return listAgents(dataRoot);
}

export async function readTeamDefinition(dataRoot: string, teamId: string) {
  return getTeam(dataRoot, teamId);
}

export async function appendProjectAuditEvent(
  dataRoot: string,
  projectId: string,
  input: Parameters<typeof appendEvent>[1]
) {
  const project = await getProject(dataRoot, projectId);
  const paths = getProjectPaths(dataRoot, project.projectId);
  return appendEvent(paths, input);
}
