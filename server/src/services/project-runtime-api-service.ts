import { createProjectLockScope, listActiveLocks } from "../data/repository/project/lock-repository.js";
import { appendEvent, eventsToNdjson, listEvents } from "../data/repository/project/event-repository.js";
import { listInboxMessages } from "../data/repository/project/inbox-repository.js";
import { addSession, getSession, listSessions, touchSession } from "../data/repository/project/session-repository.js";
import type { TaskPatchInput as ProjectTaskPatchInput } from "../data/repository/project/taskboard-repository.js";
import {
  clearRoleSessionMapping,
  ensureProjectRuntime,
  getProject,
  setRoleSessionMapping
} from "../data/repository/project/runtime-repository.js";

export type { ProjectTaskPatchInput };

export async function getProjectRuntimeContext(dataRoot: string, projectId: string) {
  const project = await getProject(dataRoot, projectId);
  const paths = await ensureProjectRuntime(dataRoot, project.projectId);
  return { project, paths };
}

export async function getProjectSessionById(dataRoot: string, projectId: string, sessionId: string) {
  const { project, paths } = await getProjectRuntimeContext(dataRoot, projectId);
  return getSession(paths, project.projectId, sessionId);
}

export async function listProjectSessionsById(dataRoot: string, projectId: string) {
  const { project, paths } = await getProjectRuntimeContext(dataRoot, projectId);
  return listSessions(paths, project.projectId);
}

export async function createProjectSession(
  dataRoot: string,
  projectId: string,
  input: Parameters<typeof addSession>[2]
) {
  const { project, paths } = await getProjectRuntimeContext(dataRoot, projectId);
  return addSession(paths, project.projectId, input);
}

export async function touchProjectSession(
  dataRoot: string,
  projectId: string,
  sessionId: string,
  patch: Parameters<typeof touchSession>[3]
) {
  const { project, paths } = await getProjectRuntimeContext(dataRoot, projectId);
  return touchSession(paths, project.projectId, sessionId, patch);
}

export async function listProjectInboxItems(dataRoot: string, projectId: string, role: string, limit?: number) {
  const { paths } = await getProjectRuntimeContext(dataRoot, projectId);
  return listInboxMessages(paths, role, limit);
}

export async function appendProjectRuntimeEvent(
  dataRoot: string,
  projectId: string,
  input: Parameters<typeof appendEvent>[1]
) {
  const { paths } = await getProjectRuntimeContext(dataRoot, projectId);
  return appendEvent(paths, input);
}

export async function listProjectRuntimeEvents(dataRoot: string, projectId: string, since?: string) {
  const { paths } = await getProjectRuntimeContext(dataRoot, projectId);
  return listEvents(paths, since);
}

export async function listProjectRuntimeEventsAsNdjson(dataRoot: string, projectId: string, since?: string) {
  return eventsToNdjson(await listProjectRuntimeEvents(dataRoot, projectId, since));
}

export async function listProjectActiveLocks(dataRoot: string, projectId: string) {
  const { project } = await getProjectRuntimeContext(dataRoot, projectId);
  const lockScope = createProjectLockScope(dataRoot, project.projectId, project.workspacePath);
  return listActiveLocks(lockScope);
}

export async function setProjectRoleSessionMapping(
  dataRoot: string,
  projectId: string,
  role: string,
  sessionId: string
) {
  return setRoleSessionMapping(dataRoot, projectId, role, sessionId);
}

export async function clearProjectRoleSessionMapping(dataRoot: string, projectId: string, role: string) {
  return clearRoleSessionMapping(dataRoot, projectId, role);
}
