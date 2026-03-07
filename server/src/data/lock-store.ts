import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { LockRecord } from "../domain/models.js";
import { ensureDirectory, readJsonFile } from "./file-utils.js";

export class LockStoreError extends Error {
  constructor(
    message: string,
    public readonly code: "INVALID_LOCK_KEY" | "INVALID_TTL" | "INVALID_OWNER" | "INVALID_SCOPE"
  ) {
    super(message);
  }
}

export interface LockScope {
  dataRoot: string;
  workspaceRoot: string;
  ownerDomain: "project" | "workflow_run";
  ownerDomainId: string;
  projectId?: string;
}

interface WorkspaceScopeInfo {
  workspaceRootAbs: string;
  workspaceComparablePath: string;
  workspaceHash: string;
  workspaceLocksDir: string;
}

interface WorkspaceLockEntry {
  file: string;
  rawLock: LockRecord;
  lock: LockRecord;
  comparableResourcePath: string;
}

interface AcquireLockInput {
  sessionId: string;
  lockKey: string;
  targetType?: "file" | "dir";
  ttlSeconds: number;
  purpose?: string;
}

type AcquireLockResult =
  | {
      kind: "acquired";
      lock: LockRecord;
    }
  | {
      kind: "stolen";
      lock: LockRecord;
      previousLock: LockRecord;
    }
  | {
      kind: "failed";
      existingLock: LockRecord;
      reason: "LOCK_HELD";
    };

type RenewLockResult =
  | { kind: "renewed"; lock: LockRecord }
  | { kind: "not_found" }
  | { kind: "not_owner"; existingLock: LockRecord }
  | { kind: "expired"; existingLock: LockRecord };

type ReleaseLockResult =
  | { kind: "released"; lock: LockRecord }
  | { kind: "not_found" }
  | { kind: "not_owner"; existingLock: LockRecord };

interface ReleaseManyInput {
  sessionId: string;
  lockKeys?: string[];
}

class WorkspaceAcquireMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const waitFor = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await waitFor.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const workspaceAcquireMutexes = new Map<string, WorkspaceAcquireMutex>();

function getWorkspaceAcquireMutex(workspaceHash: string): WorkspaceAcquireMutex {
  const existing = workspaceAcquireMutexes.get(workspaceHash);
  if (existing) {
    return existing;
  }
  const created = new WorkspaceAcquireMutex();
  workspaceAcquireMutexes.set(workspaceHash, created);
  return created;
}

function normalizeTtlSeconds(raw: number): number {
  if (!Number.isFinite(raw)) {
    throw new LockStoreError("ttl_seconds must be a number", "INVALID_TTL");
  }
  const rounded = Math.floor(raw);
  if (rounded < 1 || rounded > 24 * 60 * 60) {
    throw new LockStoreError("ttl_seconds must be between 1 and 86400", "INVALID_TTL");
  }
  return rounded;
}

function normalizeLockKey(lockKey: string): string {
  const trimmed = lockKey.trim();
  if (!trimmed) {
    throw new LockStoreError("lock_key must not be empty", "INVALID_LOCK_KEY");
  }
  const normalizedSlashes = trimmed.replace(/\\/g, "/");
  if (
    normalizedSlashes.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalizedSlashes) ||
    normalizedSlashes.includes("\u0000")
  ) {
    throw new LockStoreError("lock_key must be a workspace-relative path", "INVALID_LOCK_KEY");
  }
  const normalized = path.posix.normalize(normalizedSlashes).replace(/^\.\/+/g, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    throw new LockStoreError("lock_key must stay within workspace relative path", "INVALID_LOCK_KEY");
  }
  return normalized;
}

function sanitizeLockKey(normalizedKey: string): string {
  const slug = normalizedKey
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  const hash = createHash("sha1").update(normalizedKey).digest("hex").slice(0, 12);
  const prefix = slug.length > 0 ? slug : "lock";
  return `${prefix}-${hash}`;
}

function normalizeComparablePath(absolutePath: string): string {
  let normalized = path.normalize(path.resolve(absolutePath)).replace(/\\/g, "/");
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  const isWindowsRoot = /^[a-z]:\/$/i.test(normalized);
  if (!isWindowsRoot && normalized !== "/") {
    normalized = normalized.replace(/\/+$/g, "");
  }
  return normalized;
}

function isSameOrDescendantPath(parentPath: string, childPath: string): boolean {
  if (parentPath === childPath) {
    return true;
  }
  return childPath.startsWith(`${parentPath}/`);
}

function assertOwnerScope(scope: LockScope): void {
  const ownerDomainId = scope.ownerDomainId.trim();
  if (!ownerDomainId) {
    throw new LockStoreError("owner_domain_id must not be empty", "INVALID_OWNER");
  }
}

async function canonicalizeWorkspacePath(workspaceRoot: string): Promise<string> {
  const resolved = path.resolve(workspaceRoot);
  try {
    const real = await fs.realpath(resolved);
    return path.resolve(real);
  } catch {
    return resolved;
  }
}

async function canonicalizeResourcePath(resourceAbsPath: string): Promise<string> {
  const resolved = path.resolve(resourceAbsPath);
  const parentDir = path.dirname(resolved);
  try {
    const realParent = await fs.realpath(parentDir);
    return path.join(realParent, path.basename(resolved));
  } catch {
    return resolved;
  }
}

async function resolveWorkspaceScope(scope: LockScope): Promise<WorkspaceScopeInfo> {
  assertOwnerScope(scope);
  const workspaceRootAbs = path.resolve(scope.workspaceRoot);
  const workspaceCanonical = await canonicalizeWorkspacePath(workspaceRootAbs);
  const workspaceComparablePath = normalizeComparablePath(workspaceCanonical);
  const workspaceHash = createHash("sha1").update(workspaceComparablePath).digest("hex");
  const workspaceLocksDir = path.join(scope.dataRoot, "locks", "global", workspaceHash);
  return {
    workspaceRootAbs,
    workspaceComparablePath,
    workspaceHash,
    workspaceLocksDir
  };
}

async function resolveResourcePathInfo(
  workspaceRootAbs: string,
  workspaceComparablePath: string,
  lockKey: string
): Promise<{
  normalizedLockKey: string;
  sanitizedKey: string;
  resourceAbsPath: string;
  comparableResourcePath: string;
}> {
  const normalizedLockKey = normalizeLockKey(lockKey);
  const candidateAbsPath = path.resolve(workspaceRootAbs, normalizedLockKey);
  const resourceAbsPath = await canonicalizeResourcePath(candidateAbsPath);
  const comparableResourcePath = normalizeComparablePath(resourceAbsPath);
  if (!isSameOrDescendantPath(workspaceComparablePath, comparableResourcePath)) {
    throw new LockStoreError("lock_key resolved outside workspace root", "INVALID_LOCK_KEY");
  }
  return {
    normalizedLockKey,
    sanitizedKey: sanitizeLockKey(normalizedLockKey),
    resourceAbsPath: path.normalize(resourceAbsPath),
    comparableResourcePath
  };
}

function isExpired(lock: LockRecord, nowMs = Date.now()): boolean {
  return lock.status === "active" && Date.parse(lock.expiresAt) <= nowMs;
}

function materializeLock(lock: LockRecord, nowMs = Date.now()): LockRecord {
  if (isExpired(lock, nowMs)) {
    return { ...lock, status: "expired" };
  }
  return lock;
}

async function readLock(lockFile: string): Promise<LockRecord | null> {
  return readJsonFile<LockRecord | null>(lockFile, null);
}

async function writeLock(lockFile: string, lock: LockRecord, createOnly = false): Promise<void> {
  await ensureDirectory(path.dirname(lockFile));
  const payload = `${JSON.stringify(lock, null, 2)}\n`;
  await fs.writeFile(lockFile, payload, {
    encoding: "utf8",
    flag: createOnly ? "wx" : "w"
  });
}

async function removeLockFile(lockFile: string): Promise<void> {
  try {
    await fs.rm(lockFile, { force: true });
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code !== "ENOENT") {
      throw error;
    }
  }
}

async function listLockFiles(workspaceLocksDir: string): Promise<string[]> {
  await ensureDirectory(workspaceLocksDir);
  const entries = await fs.readdir(workspaceLocksDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(workspaceLocksDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

async function loadWorkspaceLockEntries(workspaceLocksDir: string): Promise<WorkspaceLockEntry[]> {
  const files = await listLockFiles(workspaceLocksDir);
  const entries: WorkspaceLockEntry[] = [];
  for (const file of files) {
    const rawLock = await readLock(file);
    if (!rawLock) {
      continue;
    }
    const lock = materializeLock(rawLock);
    if (!lock.resourceAbsPath || !lock.ownerDomain || !lock.ownerDomainId) {
      continue;
    }
    entries.push({
      file,
      rawLock,
      lock,
      comparableResourcePath: normalizeComparablePath(lock.resourceAbsPath)
    });
  }
  return entries;
}

function isOwnerMatch(scope: LockScope, sessionId: string, lock: LockRecord): boolean {
  return (
    lock.ownerSessionId === sessionId &&
    lock.ownerDomain === scope.ownerDomain &&
    lock.ownerDomainId === scope.ownerDomainId
  );
}

function doesHierarchicalConflict(
  requestedType: "file" | "dir",
  requestedResourcePath: string,
  existingType: "file" | "dir",
  existingResourcePath: string
): boolean {
  if (requestedType === "file") {
    if (existingType === "file") {
      return requestedResourcePath === existingResourcePath;
    }
    return isSameOrDescendantPath(existingResourcePath, requestedResourcePath);
  }

  if (existingType === "file") {
    return isSameOrDescendantPath(requestedResourcePath, existingResourcePath);
  }
  return (
    isSameOrDescendantPath(requestedResourcePath, existingResourcePath) ||
    isSameOrDescendantPath(existingResourcePath, requestedResourcePath)
  );
}

function buildActiveLock(input: {
  scope: LockScope;
  workspaceRootAbs: string;
  lockKey: string;
  sanitizedKey: string;
  resourceAbsPath: string;
  resourceType: "file" | "dir";
  sessionId: string;
  ttlSeconds: number;
  purpose?: string;
  stealReason?: string;
  stolenFromSessionId?: string;
}): LockRecord {
  const nowMs = Date.now();
  const projectId = input.scope.projectId ?? "";
  return {
    schemaVersion: "1.0",
    lockId: randomUUID(),
    projectId,
    lockKey: input.lockKey,
    sanitizedKey: input.sanitizedKey,
    workspaceRootAbs: input.workspaceRootAbs,
    resourceAbsPath: input.resourceAbsPath,
    resourceType: input.resourceType,
    ownerDomain: input.scope.ownerDomain,
    ownerDomainId: input.scope.ownerDomainId,
    ownerSessionId: input.sessionId,
    targetType: input.resourceType,
    purpose: input.purpose,
    ttlSeconds: input.ttlSeconds,
    acquiredAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + input.ttlSeconds * 1000).toISOString(),
    renewCount: 0,
    status: "active",
    stealReason: input.stealReason,
    stolenFromSessionId: input.stolenFromSessionId
  };
}

function pickLatestByAcquiredAt(entries: WorkspaceLockEntry[]): WorkspaceLockEntry {
  return [...entries].sort((a, b) => Date.parse(b.lock.acquiredAt) - Date.parse(a.lock.acquiredAt))[0];
}

export function createProjectLockScope(dataRoot: string, projectId: string, workspaceRoot: string): LockScope {
  return {
    dataRoot,
    workspaceRoot,
    ownerDomain: "project",
    ownerDomainId: projectId,
    projectId
  };
}

export function createWorkflowRunLockScope(
  dataRoot: string,
  runId: string,
  workspaceRoot: string
): LockScope {
  return {
    dataRoot,
    workspaceRoot,
    ownerDomain: "workflow_run",
    ownerDomainId: runId
  };
}

export async function acquireLock(scope: LockScope, input: AcquireLockInput): Promise<AcquireLockResult> {
  const ttlSeconds = normalizeTtlSeconds(input.ttlSeconds);
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    throw new LockStoreError("session_id must not be empty", "INVALID_OWNER");
  }
  const workspace = await resolveWorkspaceScope(scope);
  const resource = await resolveResourcePathInfo(workspace.workspaceRootAbs, workspace.workspaceComparablePath, input.lockKey);
  const resourceType = input.targetType === "dir" ? "dir" : "file";
  const purpose = input.purpose?.trim() || undefined;

  return getWorkspaceAcquireMutex(workspace.workspaceHash).runExclusive(async () => {
    const entries = await loadWorkspaceLockEntries(workspace.workspaceLocksDir);
    let previousExpiredLock: LockRecord | undefined;

    for (const entry of entries) {
      const existingType = entry.lock.resourceType ?? entry.lock.targetType ?? "file";
      const conflict = doesHierarchicalConflict(
        resourceType,
        resource.comparableResourcePath,
        existingType,
        entry.comparableResourcePath
      );
      if (!conflict) {
        continue;
      }
      if (entry.lock.status !== "active") {
        if (!previousExpiredLock && entry.lock.status === "expired") {
          previousExpiredLock = entry.lock;
        }
        await removeLockFile(entry.file);
        continue;
      }
      return {
        kind: "failed",
        existingLock: entry.lock,
        reason: "LOCK_HELD"
      };
    }

    const nextLock = buildActiveLock({
      scope,
      workspaceRootAbs: workspace.workspaceRootAbs,
      lockKey: resource.normalizedLockKey,
      sanitizedKey: resource.sanitizedKey,
      resourceAbsPath: resource.resourceAbsPath,
      resourceType,
      sessionId,
      ttlSeconds,
      purpose,
      stealReason: previousExpiredLock ? "lock expired and was stolen" : undefined,
      stolenFromSessionId: previousExpiredLock?.ownerSessionId
    });
    const lockFile = path.join(workspace.workspaceLocksDir, `${nextLock.sanitizedKey}-${nextLock.lockId}.json`);
    await writeLock(lockFile, nextLock, true);
    if (previousExpiredLock) {
      return {
        kind: "stolen",
        lock: nextLock,
        previousLock: previousExpiredLock
      };
    }
    return {
      kind: "acquired",
      lock: nextLock
    };
  });
}

export async function renewLock(
  scope: LockScope,
  input: { sessionId: string; lockKey: string }
): Promise<RenewLockResult> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    throw new LockStoreError("session_id must not be empty", "INVALID_OWNER");
  }
  const workspace = await resolveWorkspaceScope(scope);
  const normalizedLockKey = normalizeLockKey(input.lockKey);
  const entries = await loadWorkspaceLockEntries(workspace.workspaceLocksDir);
  const keyMatched = entries.filter((entry) => entry.lock.lockKey === normalizedLockKey);
  if (keyMatched.length === 0) {
    return { kind: "not_found" };
  }

  const ownerMatched = keyMatched.filter((entry) => isOwnerMatch(scope, sessionId, entry.lock));
  if (ownerMatched.length === 0) {
    return { kind: "not_owner", existingLock: pickLatestByAcquiredAt(keyMatched).lock };
  }
  const target = pickLatestByAcquiredAt(ownerMatched);
  if (target.lock.status !== "active") {
    return { kind: "expired", existingLock: target.lock };
  }

  const nowMs = Date.now();
  const renewed: LockRecord = {
    ...target.rawLock,
    expiresAt: new Date(nowMs + target.rawLock.ttlSeconds * 1000).toISOString(),
    renewCount: target.rawLock.renewCount + 1,
    status: "active"
  };
  await writeLock(target.file, renewed);
  return { kind: "renewed", lock: renewed };
}

export async function releaseLock(
  scope: LockScope,
  input: { sessionId: string; lockKey: string }
): Promise<ReleaseLockResult> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    throw new LockStoreError("session_id must not be empty", "INVALID_OWNER");
  }
  const workspace = await resolveWorkspaceScope(scope);
  const normalizedLockKey = normalizeLockKey(input.lockKey);
  const entries = await loadWorkspaceLockEntries(workspace.workspaceLocksDir);
  const keyMatched = entries.filter((entry) => entry.lock.lockKey === normalizedLockKey);
  if (keyMatched.length === 0) {
    return { kind: "not_found" };
  }
  const ownerMatched = keyMatched.filter((entry) => isOwnerMatch(scope, sessionId, entry.lock));
  if (ownerMatched.length === 0) {
    return { kind: "not_owner", existingLock: pickLatestByAcquiredAt(keyMatched).lock };
  }
  const target = pickLatestByAcquiredAt(ownerMatched);
  const released: LockRecord = {
    ...target.rawLock,
    status: "released",
    releasedAt: new Date().toISOString(),
    expiresAt: new Date().toISOString()
  };
  await removeLockFile(target.file);
  return { kind: "released", lock: released };
}

export async function listLocks(scope: LockScope): Promise<LockRecord[]> {
  const workspace = await resolveWorkspaceScope(scope);
  const entries = await loadWorkspaceLockEntries(workspace.workspaceLocksDir);
  return entries.map((entry) => entry.lock).sort((a, b) => a.lockKey.localeCompare(b.lockKey));
}

export async function listActiveLocks(scope: LockScope): Promise<LockRecord[]> {
  const all = await listLocks(scope);
  return all.filter((lock) => lock.status === "active");
}

export async function releaseLocks(scope: LockScope, input: ReleaseManyInput): Promise<LockRecord[]> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    throw new LockStoreError("session_id must not be empty", "INVALID_OWNER");
  }
  const normalizedKeys = input.lockKeys?.map((key) => {
    try {
      return normalizeLockKey(key);
    } catch {
      return null;
    }
  }).filter((item): item is string => item !== null);

  const locks = await listLocks(scope);
  const targets = locks.filter((lock) => {
    if (!isOwnerMatch(scope, sessionId, lock)) {
      return false;
    }
    if (lock.status !== "active") {
      return false;
    }
    if (!normalizedKeys || normalizedKeys.length === 0) {
      return true;
    }
    return normalizedKeys.includes(lock.lockKey);
  });

  const released: LockRecord[] = [];
  for (const target of targets) {
    const result = await releaseLock(scope, {
      sessionId,
      lockKey: target.lockKey
    });
    if (result.kind === "released") {
      released.push(result.lock);
    }
  }
  return released;
}

export type { AcquireLockInput, AcquireLockResult, RenewLockResult, ReleaseLockResult };
