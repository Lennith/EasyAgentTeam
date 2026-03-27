import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./storage/atomic-writer.js";
import {
  ensureStorageRecoveryForPaths,
  getActiveTransactionPendingFileContent,
  getActiveStorageTransaction,
  withStorageTransaction
} from "./storage/transaction-manager.js";

const JSON_READ_RETRY_ATTEMPTS = 3;
const JSON_READ_RETRY_BASE_DELAY_MS = 15;

class FileAccessMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

const fileAccessMutexes = new Map<string, FileAccessMutex>();

function getFileAccessMutex(targetFile: string): FileAccessMutex {
  const existing = fileAccessMutexes.get(targetFile);
  if (existing) {
    return existing;
  }
  const created = new FileAccessMutex();
  fileAccessMutexes.set(targetFile, created);
  return created;
}

function withFileAccessLock<T>(targetFile: string, operation: () => Promise<T>): Promise<T> {
  return getFileAccessMutex(targetFile).runExclusive(operation);
}

function isUnexpectedEndJsonError(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) {
    return false;
  }
  const message = error.message || "";
  return message.includes("Unexpected end of JSON input");
}

function isJsonSyntaxError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureDirectory(targetDir: string): Promise<void> {
  await ensureStorageRecoveryForPaths([targetDir]);
  const active = getActiveStorageTransaction();
  if (active) {
    await active.mkdir(targetDir);
    return;
  }
  await fs.mkdir(targetDir, { recursive: true });
}

export async function ensureFile(targetFile: string, initialContent: string): Promise<void> {
  await ensureStorageRecoveryForPaths([targetFile]);
  await withFileAccessLock(targetFile, async () => {
    try {
      await fs.access(targetFile);
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code !== "ENOENT") {
        throw error;
      }
      await ensureDirectory(path.dirname(targetFile));
      await writeFileAtomic(targetFile, initialContent);
    }
  });
}

export async function readJsonFile<T>(targetFile: string, fallback: T): Promise<T> {
  await ensureStorageRecoveryForPaths([targetFile]);
  const pending = getActiveTransactionPendingFileContent(targetFile);
  if (pending !== undefined) {
    try {
      return JSON.parse(pending) as T;
    } catch {
      return fallback;
    }
  }
  for (let attempt = 0; attempt < JSON_READ_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const raw = await withFileAccessLock(targetFile, () => fs.readFile(targetFile, "utf8"));
      return JSON.parse(raw) as T;
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        return fallback;
      }
      if (isUnexpectedEndJsonError(error) && attempt < JSON_READ_RETRY_ATTEMPTS - 1) {
        await delay(JSON_READ_RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  return fallback;
}

export async function writeJsonFile(targetFile: string, payload: unknown): Promise<void> {
  await ensureStorageRecoveryForPaths([targetFile]);
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const active = getActiveStorageTransaction();
  if (active) {
    await active.putJson(targetFile, serialized);
    return;
  }
  await withStorageTransaction([targetFile], async () => {
    const tx = getActiveStorageTransaction();
    if (!tx) {
      throw new Error("Storage transaction context missing for writeJsonFile");
    }
    await tx.putJson(targetFile, serialized);
  });
}

export async function appendJsonlLine(targetFile: string, payload: unknown): Promise<void> {
  await ensureStorageRecoveryForPaths([targetFile]);
  const line = `${JSON.stringify(payload)}\n`;
  const active = getActiveStorageTransaction();
  if (active) {
    await active.appendJsonl(targetFile, line);
    return;
  }
  await withStorageTransaction([targetFile], async () => {
    const tx = getActiveStorageTransaction();
    if (!tx) {
      throw new Error("Storage transaction context missing for appendJsonlLine");
    }
    await tx.appendJsonl(targetFile, line);
  });
}

export async function readJsonlLines<T>(targetFile: string): Promise<T[]> {
  await ensureStorageRecoveryForPaths([targetFile]);
  const pending = getActiveTransactionPendingFileContent(targetFile);
  if (pending !== undefined) {
    return parseJsonlLinesFromRaw<T>(pending);
  }
  for (let attempt = 0; attempt < JSON_READ_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const raw = await withFileAccessLock(targetFile, () => fs.readFile(targetFile, "utf8"));
      const rawLines = raw.split("\n");
      const parsed: T[] = [];
      let parseError: unknown = null;
      let recoverablePartialTail = false;

      for (let i = 0; i < rawLines.length; i += 1) {
        const line = rawLines[i]?.trim() ?? "";
        if (line.length === 0) {
          continue;
        }
        try {
          parsed.push(JSON.parse(line) as T);
        } catch (error) {
          const isLastLine =
            i === rawLines.length - 1 || (i === rawLines.length - 2 && rawLines[rawLines.length - 1] === "");
          recoverablePartialTail = isLastLine && !raw.endsWith("\n") && isJsonSyntaxError(error);
          parseError = error;
          break;
        }
      }

      if (!parseError) {
        return parsed;
      }

      if (isJsonSyntaxError(parseError) && attempt < JSON_READ_RETRY_ATTEMPTS - 1) {
        await delay(JSON_READ_RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      if (recoverablePartialTail) {
        return parsed;
      }
      throw parseError;
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        return [];
      }
      if (isJsonSyntaxError(error) && attempt < JSON_READ_RETRY_ATTEMPTS - 1) {
        await delay(JSON_READ_RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  return [];
}

function parseJsonlLinesFromRaw<T>(raw: string): T[] {
  const rawLines = raw.split("\n");
  const parsed: T[] = [];
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    parsed.push(JSON.parse(line) as T);
  }
  return parsed;
}

export async function writeJsonlLines<T>(targetFile: string, lines: T[]): Promise<void> {
  await ensureStorageRecoveryForPaths([targetFile]);
  const content = lines.map((line) => JSON.stringify(line)).join("\n");
  const finalContent = content.length > 0 ? `${content}\n` : "";
  const active = getActiveStorageTransaction();
  if (active) {
    await active.overwriteJsonl(targetFile, finalContent);
    return;
  }
  await withStorageTransaction([targetFile], async () => {
    const tx = getActiveStorageTransaction();
    if (!tx) {
      throw new Error("Storage transaction context missing for writeJsonlLines");
    }
    await tx.overwriteJsonl(targetFile, finalContent);
  });
}

export async function runStorageTransaction<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
  return withStorageTransaction(paths, operation);
}

export async function deleteDirectoryTransactional(targetDir: string): Promise<void> {
  const anchorPaths = [path.dirname(targetDir), targetDir];
  await ensureStorageRecoveryForPaths(anchorPaths);
  const active = getActiveStorageTransaction();
  if (active) {
    await active.deleteDir(targetDir);
    return;
  }
  await withStorageTransaction(anchorPaths, async () => {
    const tx = getActiveStorageTransaction();
    if (!tx) {
      throw new Error("Storage transaction context missing for deleteDirectoryTransactional");
    }
    await tx.deleteDir(targetDir);
  });
}

export async function deleteFileTransactional(targetFile: string): Promise<void> {
  const anchorPaths = [path.dirname(targetFile), targetFile];
  await ensureStorageRecoveryForPaths(anchorPaths);
  const active = getActiveStorageTransaction();
  if (active) {
    await active.deleteFile(targetFile);
    return;
  }
  await withStorageTransaction(anchorPaths, async () => {
    const tx = getActiveStorageTransaction();
    if (!tx) {
      throw new Error("Storage transaction context missing for deleteFileTransactional");
    }
    await tx.deleteFile(targetFile);
  });
}
