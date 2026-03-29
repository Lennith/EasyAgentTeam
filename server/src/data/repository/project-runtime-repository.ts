import type { ProjectPaths, ProjectRecord, ProjectSummary, RoleReminderState } from "../../domain/models.js";
import {
  clearRoleSessionMapping,
  createProject,
  deleteProject,
  ensureProjectRuntime,
  getProject,
  getProjectOverview,
  getProjectPaths,
  listProjects,
  setRoleSessionMapping,
  updateProjectOrchestratorSettings,
  updateProjectRouting,
  updateTaskAssignRouting
} from "../project-store.js";
import { getRoleReminderState, updateRoleReminderState } from "../role-reminder-store.js";

export type CreateProjectInput = Parameters<typeof createProject>[1];
export type ProjectOverviewRecord = Awaited<ReturnType<typeof getProjectOverview>>;
export type UpdateProjectRoutingInput = Parameters<typeof updateProjectRouting>[2];
export type UpdateProjectOrchestratorSettingsInput = Parameters<typeof updateProjectOrchestratorSettings>[2];
export type RoleReminderUpdates = Partial<Omit<RoleReminderState, "role">>;

export interface ProjectRuntimeRepository {
  getProjectPaths(projectId: string): ProjectPaths;
  ensureProjectRuntime(projectId: string): Promise<ProjectPaths>;
  createProject(input: CreateProjectInput): Promise<{ project: ProjectRecord; paths: ProjectPaths }>;
  getProject(projectId: string): Promise<ProjectRecord>;
  getProjectOverview(projectId: string): Promise<ProjectOverviewRecord>;
  listProjects(): Promise<ProjectSummary[]>;
  updateProjectRouting(projectId: string, input: UpdateProjectRoutingInput): Promise<ProjectRecord>;
  updateTaskAssignRouting(projectId: string, taskAssignRouteTable: Record<string, string[]>): Promise<ProjectRecord>;
  updateProjectOrchestratorSettings(projectId: string, input: UpdateProjectOrchestratorSettingsInput): Promise<ProjectRecord>;
  setRoleSessionMapping(projectId: string, role: string, sessionId: string): Promise<ProjectRecord>;
  clearRoleSessionMapping(projectId: string, role: string): Promise<ProjectRecord>;
  getRoleReminderState(paths: ProjectPaths, projectId: string, role: string): Promise<RoleReminderState | null>;
  updateRoleReminderState(
    paths: ProjectPaths,
    projectId: string,
    role: string,
    updates: RoleReminderUpdates
  ): Promise<RoleReminderState>;
  deleteProject(projectId: string): Promise<{ projectId: string; removedAt: string }>;
}

class DefaultProjectRuntimeRepository implements ProjectRuntimeRepository {
  constructor(private readonly dataRoot: string) {}

  getProjectPaths(projectId: string): ProjectPaths {
    return getProjectPaths(this.dataRoot, projectId);
  }

  ensureProjectRuntime(projectId: string): Promise<ProjectPaths> {
    return ensureProjectRuntime(this.dataRoot, projectId);
  }

  createProject(input: CreateProjectInput): Promise<{ project: ProjectRecord; paths: ProjectPaths }> {
    return createProject(this.dataRoot, input);
  }

  getProject(projectId: string): Promise<ProjectRecord> {
    return getProject(this.dataRoot, projectId);
  }

  getProjectOverview(projectId: string): Promise<ProjectOverviewRecord> {
    return getProjectOverview(this.dataRoot, projectId);
  }

  listProjects(): Promise<ProjectSummary[]> {
    return listProjects(this.dataRoot);
  }

  updateProjectRouting(projectId: string, input: UpdateProjectRoutingInput): Promise<ProjectRecord> {
    return updateProjectRouting(this.dataRoot, projectId, input);
  }

  updateTaskAssignRouting(projectId: string, taskAssignRouteTable: Record<string, string[]>): Promise<ProjectRecord> {
    return updateTaskAssignRouting(this.dataRoot, projectId, taskAssignRouteTable);
  }

  updateProjectOrchestratorSettings(
    projectId: string,
    input: UpdateProjectOrchestratorSettingsInput
  ): Promise<ProjectRecord> {
    return updateProjectOrchestratorSettings(this.dataRoot, projectId, input);
  }

  setRoleSessionMapping(projectId: string, role: string, sessionId: string): Promise<ProjectRecord> {
    return setRoleSessionMapping(this.dataRoot, projectId, role, sessionId);
  }

  clearRoleSessionMapping(projectId: string, role: string): Promise<ProjectRecord> {
    return clearRoleSessionMapping(this.dataRoot, projectId, role);
  }

  getRoleReminderState(paths: ProjectPaths, projectId: string, role: string): Promise<RoleReminderState | null> {
    return getRoleReminderState(paths, projectId, role);
  }

  updateRoleReminderState(
    paths: ProjectPaths,
    projectId: string,
    role: string,
    updates: RoleReminderUpdates
  ): Promise<RoleReminderState> {
    return updateRoleReminderState(paths, projectId, role, updates);
  }

  deleteProject(projectId: string): Promise<{ projectId: string; removedAt: string }> {
    return deleteProject(this.dataRoot, projectId);
  }
}

export function createProjectRuntimeRepository(dataRoot: string): ProjectRuntimeRepository {
  return new DefaultProjectRuntimeRepository(dataRoot);
}
