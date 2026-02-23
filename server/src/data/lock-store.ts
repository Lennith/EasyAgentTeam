import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { LockRecord, ProjectPaths } from "../domain/models.js";
import { ensureDirectory, readJsonFile } from "./file-utils.js";

export class LockStoreError extends Error {
  constructor(message: string, public readonly code: "INVALID_LOCK_KEY" | "INVALID_TTL") {
    super(message);
  }
}

interface LockPathInfo {
  normalizedLockKey: string;
  sanitizedKey: string;
  lockFile: string;
}

interface AcquireLockInput {
  projectId: string;
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
  projectId: string;
  sessionId: string;
  lockKeys?: string[];
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

export function resolveLockPath(paths: ProjectPaths, lockKey: string): LockPathInfo {
  const normalizedLockKey = normalizeLockKey(lockKey);
  const sanitizedKey = sanitizeLockKey(normalizedLockKey);
  return {
    normalizedLockKey,
    sanitizedKey,
    lockFile: path.join(paths.locksDir, `${sanitizedKey}.json`)
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

function buildActiveLock(input: {
  projectId: string;
  sessionId: string;
  lockKey: string;
  sanitizedKey: string;
  targetType?: "file" | "dir";
  ttlSeconds: number;
  purpose?: string;
  stealReason?: string;
  stolenFromSessionId?: string;
}): LockRecord {
  const nowMs = Date.now();
  return {
    schemaVersion: "1.0",
    lockId: randomUUID(),
    projectId: input.projectId,
    lockKey: input.lockKey,
    sanitizedKey: input.sanitizedKey,
    ownerSessionId: input.sessionId,
    targetType: input.targetType,
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

export async function acquireLock(paths: ProjectPaths, input: AcquireLockInput): Promise<AcquireLockResult> {
  const ttlSeconds = normalizeTtlSeconds(input.ttlSeconds);
  const pathInfo = resolveLockPath(paths, input.lockKey);
  let previousExpiredLock: LockRecord | undefined;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nextLock = buildActiveLock({
      projectId: input.projectId,
      sessionId: input.sessionId,
      lockKey: pathInfo.normalizedLockKey,
      sanitizedKey: pathInfo.sanitizedKey,
      targetType: input.targetType,
      ttlSeconds,
      purpose: input.purpose,
      stealReason: previousExpiredLock ? "lock expired and was stolen" : undefined,
      stolenFromSessionId: previousExpiredLock?.ownerSessionId
    });

    try {
      await writeLock(pathInfo.lockFile, nextLock, true);
      if (previousExpiredLock) {
        return {
          kind: "stolen",
          lock: nextLock,
          previousLock: materializeLock(previousExpiredLock)
        };
      }
      return { kind: "acquired", lock: nextLock };
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code !== "EEXIST") {
        throw error;
      }
    }

    const existingLock = await readLock(pathInfo.lockFile);
    if (!existingLock) {
      continue;
    }

    const existing = materializeLock(existingLock);
    if (existing.status !== "active") {
      previousExpiredLock = existing;
      try {
        await fs.rm(pathInfo.lockFile, { force: true });
      } catch (error) {
        const known = error as NodeJS.ErrnoException;
        if (known.code !== "ENOENT") {
          throw error;
        }
      }
      continue;
    }

    return {
      kind: "failed",
      existingLock: existing,
      reason: "LOCK_HELD"
    };
  }

  throw new Error(`Failed to acquire lock for '${input.lockKey}' due to repeated concurrent changes`);
}

export async function renewLock(
  paths: ProjectPaths,
  input: { sessionId: string; lockKey: string }
): Promise<RenewLockResult> {
  const pathInfo = resolveLockPath(paths, input.lockKey);
  const existingRaw = await readLock(pathInfo.lockFile);
  if (!existingRaw) {
    return { kind: "not_found" };
  }

  const existing = materializeLock(existingRaw);
  if (existing.ownerSessionId !== input.sessionId) {
    return { kind: "not_owner", existingLock: existing };
  }
  if (existing.status !== "active") {
    return { kind: "expired", existingLock: existing };
  }

  const nowMs = Date.now();
  const renewed: LockRecord = {
    ...existingRaw,
    expiresAt: new Date(nowMs + existingRaw.ttlSeconds * 1000).toISOString(),
    renewCount: existingRaw.renewCount + 1,
    status: "active"
  };
  await writeLock(pathInfo.lockFile, renewed);
  return { kind: "renewed", lock: renewed };
}

export async function releaseLock(
  paths: ProjectPaths,
  input: { sessionId: string; lockKey: string }
): Promise<ReleaseLockResult> {
  const pathInfo = resolveLockPath(paths, input.lockKey);
  const existingRaw = await readLock(pathInfo.lockFile);
  if (!existingRaw) {
    return { kind: "not_found" };
  }
  const existing = materializeLock(existingRaw);
  if (existing.ownerSessionId !== input.sessionId) {
    return { kind: "not_owner", existingLock: existing };
  }

  const released: LockRecord = {
    ...existingRaw,
    status: "released",
    releasedAt: new Date().toISOString(),
    expiresAt: new Date().toISOString()
  };

  await fs.rm(pathInfo.lockFile, { force: true });
  return { kind: "released", lock: released };
}

async function listLockFiles(locksDir: string): Promise<string[]> {
  await ensureDirectory(locksDir);
  const entries = await fs.readdir(locksDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(locksDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export async function listLocks(paths: ProjectPaths): Promise<LockRecord[]> {
  const files = await listLockFiles(paths.locksDir);
  const locks: LockRecord[] = [];
  for (const file of files) {
    const lock = await readLock(file);
    if (lock) {
      locks.push(materializeLock(lock));
    }
  }
  return locks.sort((a, b) => a.lockKey.localeCompare(b.lockKey));
}

export async function listActiveLocks(paths: ProjectPaths): Promise<LockRecord[]> {
  const all = await listLocks(paths);
  return all.filter((lock) => lock.status === "active");
}

export async function releaseLocks(
  paths: ProjectPaths,
  input: ReleaseManyInput
): Promise<LockRecord[]> {
  const normalizedKeys = input.lockKeys?.map((key) => {
    try {
      return normalizeLockKey(key);
    } catch {
      return null;
    }
  }).filter((item): item is string => item !== null);

  const locks = await listLocks(paths);
  const targets = locks.filter((lock) => {
    if (lock.ownerSessionId !== input.sessionId) {
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
    const result = await releaseLock(paths, {
      sessionId: input.sessionId,
      lockKey: target.lockKey
    });
    if (result.kind === "released") {
      released.push(result.lock);
    }
  }
  return released;
}

export type { AcquireLockInput, AcquireLockResult, RenewLockResult, ReleaseLockResult };
