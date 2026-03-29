import { acquireLock, createProjectLockScope, listActiveLocks, releaseLock, renewLock } from "../data/lock-store.js";
import { ensureProjectRuntime, getProject } from "../data/project-store.js";

type ProjectLockTargetType = "file" | "dir";

export interface AcquireProjectLockInput {
  dataRoot: string;
  projectId: string;
  sessionId: string;
  lockKey: string;
  targetType?: ProjectLockTargetType;
  ttlSeconds: number;
  purpose?: string;
}

export interface RenewProjectLockInput {
  dataRoot: string;
  projectId: string;
  sessionId: string;
  lockKey: string;
}

async function resolveProjectLockScope(dataRoot: string, projectId: string) {
  const project = await getProject(dataRoot, projectId);
  await ensureProjectRuntime(dataRoot, project.projectId);
  return createProjectLockScope(dataRoot, project.projectId, project.workspacePath);
}

export async function acquireProjectLock(input: AcquireProjectLockInput) {
  const lockScope = await resolveProjectLockScope(input.dataRoot, input.projectId);
  return acquireLock(lockScope, {
    sessionId: input.sessionId,
    lockKey: input.lockKey,
    targetType: input.targetType,
    ttlSeconds: input.ttlSeconds,
    purpose: input.purpose
  });
}

export async function renewProjectLockForApi(input: RenewProjectLockInput) {
  const lockScope = await resolveProjectLockScope(input.dataRoot, input.projectId);
  return renewLock(lockScope, { sessionId: input.sessionId, lockKey: input.lockKey });
}

export async function releaseProjectLockForApi(input: RenewProjectLockInput) {
  const lockScope = await resolveProjectLockScope(input.dataRoot, input.projectId);
  return releaseLock(lockScope, { sessionId: input.sessionId, lockKey: input.lockKey });
}

export async function listProjectLocksForApi(dataRoot: string, projectId: string) {
  const lockScope = await resolveProjectLockScope(dataRoot, projectId);
  return listActiveLocks(lockScope);
}
