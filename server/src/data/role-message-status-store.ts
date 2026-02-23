import type { ProjectPaths, RoleMessageStatus, PendingConfirmedMessage, ProjectRecord } from "../domain/models.js";
import { readJsonFile, writeJsonFile } from "./file-utils.js";
import { logger } from "../utils/logger.js";

const EMPTY_STATUS: RoleMessageStatus = {
  confirmedMessageIds: [],
  pendingConfirmedMessages: []
};

async function readProjectFromPaths(paths: ProjectPaths): Promise<ProjectRecord> {
  const project = await readJsonFile<ProjectRecord | null>(paths.projectConfigFile, null);
  if (!project) {
    throw new Error(`Project config not found at ${paths.projectConfigFile}`);
  }
  return project;
}

export function getRoleMessageStatus(
  project: { roleMessageStatus?: Record<string, RoleMessageStatus> },
  role: string
): RoleMessageStatus {
  const normalizedRole = role.trim();
  if (!normalizedRole) {
    return { ...EMPTY_STATUS };
  }
  return project.roleMessageStatus?.[normalizedRole] ?? { ...EMPTY_STATUS };
}

export async function updateRoleMessageStatus(
  paths: ProjectPaths,
  projectId: string,
  role: string,
  status: RoleMessageStatus
): Promise<void> {
  const project = await readProjectFromPaths(paths);
  const normalizedRole = role.trim();
  if (!normalizedRole) {
    return;
  }

  const updatedProject = {
    ...project,
    roleMessageStatus: {
      ...(project.roleMessageStatus ?? {}),
      [normalizedRole]: status
    },
    updatedAt: new Date().toISOString()
  };

  await writeJsonFile(paths.projectConfigFile, updatedProject);
}

export async function addPendingMessagesForRole(
  paths: ProjectPaths,
  projectId: string,
  role: string,
  messages: PendingConfirmedMessage[]
): Promise<RoleMessageStatus> {
  const project = await readProjectFromPaths(paths);
  const current = getRoleMessageStatus(project, role);
  
  const updated: RoleMessageStatus = {
    ...current,
    pendingConfirmedMessages: [...current.pendingConfirmedMessages, ...messages]
  };

  await updateRoleMessageStatus(paths, projectId, role, updated);
  return updated;
}

export async function confirmPendingMessagesForRole(
  paths: ProjectPaths,
  projectId: string,
  role: string
): Promise<RoleMessageStatus> {
  const project = await readProjectFromPaths(paths);
  const current = getRoleMessageStatus(project, role);
  
  const pending = current.pendingConfirmedMessages;
  const existingConfirmed = current.confirmedMessageIds;
  
  const updated: RoleMessageStatus = {
    confirmedMessageIds: [...existingConfirmed, ...pending.map(p => p.messageId)],
    pendingConfirmedMessages: [],
    lastDispatchedAt: current.lastDispatchedAt
  };

  logger.info(`[confirmPendingMessagesForRole] role=${role}, moving ${pending.length} pending messages to confirmed`);
  await updateRoleMessageStatus(paths, projectId, role, updated);
  return updated;
}

export async function setLastDispatchedAtForRole(
  paths: ProjectPaths,
  projectId: string,
  role: string,
  timestamp: string
): Promise<void> {
  const project = await readProjectFromPaths(paths);
  const current = getRoleMessageStatus(project, role);
  
  const updated: RoleMessageStatus = {
    ...current,
    lastDispatchedAt: timestamp
  };

  await updateRoleMessageStatus(paths, projectId, role, updated);
}

