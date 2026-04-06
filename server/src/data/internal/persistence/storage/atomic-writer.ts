import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

const ATOMIC_RENAME_MAX_ATTEMPTS = 20;
const ATOMIC_RENAME_BASE_DELAY_MS = 25;
const ATOMIC_RENAME_MAX_DELAY_MS = 400;

export async function writeFileAtomic(targetFile: string, content: string): Promise<void> {
  const dir = path.dirname(targetFile);
  const tempFile = `${targetFile}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  await fs.mkdir(dir, { recursive: true });

  let fileHandle: FileHandle | null = null;
  try {
    fileHandle = await fs.open(tempFile, "w");
    await fileHandle.writeFile(content, "utf8");
    await fileHandle.sync();
  } finally {
    await fileHandle?.close();
  }

  try {
    await renameWithRetry(tempFile, targetFile);
  } catch (error) {
    await cleanupTempFileBestEffort(tempFile);
    throw error;
  }
  await fsyncDirectorySafe(dir);
}

export async function truncateFileAtomic(targetFile: string, size: number): Promise<void> {
  const handle = await fs.open(targetFile, "r+");
  try {
    await handle.truncate(size);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectorySafe(dir: string): Promise<void> {
  let dirHandle: FileHandle | null = null;
  try {
    dirHandle = await fs.open(dir, "r");
    await dirHandle.sync();
  } catch {
    // Directory fsync may fail on some platforms/filesystems; best-effort is sufficient here.
  } finally {
    await dirHandle?.close();
  }
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 1; attempt <= ATOMIC_RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (!isTransientRenameError(known) || attempt >= ATOMIC_RENAME_MAX_ATTEMPTS) {
        throw error;
      }
      await delayMs(backoffDelayMs(attempt));
    }
  }
}

function isTransientRenameError(error: NodeJS.ErrnoException): boolean {
  return (
    error.code === "EPERM" ||
    error.code === "EBUSY" ||
    error.code === "EACCES" ||
    error.code === "ENOTEMPTY"
  );
}

function backoffDelayMs(attempt: number): number {
  const candidate = ATOMIC_RENAME_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(ATOMIC_RENAME_MAX_DELAY_MS, candidate);
}

async function delayMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupTempFileBestEffort(tempFile: string): Promise<void> {
  try {
    await fs.rm(tempFile, { force: true });
  } catch {
    // Keep best-effort cleanup non-blocking for atomic write errors.
  }
}
