import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-writer.js";

export interface WalPreparedPutJsonOperation {
  type: "putJson";
  filePath: string;
  nextContent: string;
  previousContent: string | null;
}

export interface WalPreparedOverwriteJsonlOperation {
  type: "overwriteJsonl";
  filePath: string;
  nextContent: string;
  previousContent: string | null;
}

export interface WalPreparedAppendJsonlOperation {
  type: "appendJsonl";
  filePath: string;
  line: string;
  previousSize: number | null;
}

export interface WalPreparedMkdirOperation {
  type: "mkdir";
  dirPath: string;
  existedBefore: boolean;
}

export interface WalPreparedRenameDirOperation {
  type: "renameDir";
  sourcePath: string;
  targetPath: string;
  sourceExisted: boolean;
  targetExisted: boolean;
}

export interface WalPreparedDeleteDirOperation {
  type: "deleteDir";
  dirPath: string;
  trashPath: string;
  sourceExisted: boolean;
}

export interface WalPreparedDeleteFileOperation {
  type: "deleteFile";
  filePath: string;
  trashPath: string;
  sourceExisted: boolean;
}

export type WalPreparedOperation =
  | WalPreparedPutJsonOperation
  | WalPreparedOverwriteJsonlOperation
  | WalPreparedAppendJsonlOperation
  | WalPreparedMkdirOperation
  | WalPreparedRenameDirOperation
  | WalPreparedDeleteDirOperation
  | WalPreparedDeleteFileOperation;

export interface WalRecord {
  schemaVersion: "1.0";
  txId: string;
  state: "prepared" | "committed";
  preparedAt: string;
  committedAt?: string;
  operations: WalPreparedOperation[];
}

const WAL_READ_MAX_ATTEMPTS = 8;
const WAL_READ_BASE_DELAY_MS = 20;
const WAL_READ_MAX_DELAY_MS = 240;
const TRANSIENT_WAL_READ_ERROR_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ETXTBSY"]);

type StorageAccessErrorCode = "STORAGE_TEMPORARILY_UNAVAILABLE";

export class StorageAccessError extends Error {
  readonly code: StorageAccessErrorCode;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "StorageAccessError";
    this.code = "STORAGE_TEMPORARILY_UNAVAILABLE";
    this.details = details;
  }
}

class WalDirectoryMutex {
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

const walDirectoryMutexes = new Map<string, WalDirectoryMutex>();

function getWalDirectoryMutex(walDir: string): WalDirectoryMutex {
  const key = path.resolve(walDir).toLowerCase();
  const existing = walDirectoryMutexes.get(key);
  if (existing) {
    return existing;
  }
  const created = new WalDirectoryMutex();
  walDirectoryMutexes.set(key, created);
  return created;
}

export async function withWalDirectoryLock<T>(walDir: string, operation: () => Promise<T>): Promise<T> {
  return getWalDirectoryMutex(walDir).runExclusive(operation);
}

function walFilePath(walDir: string, txId: string): string {
  return path.join(walDir, `${txId}.wal.json`);
}

export async function writeWalPrepare(
  walDir: string,
  txId: string,
  operations: WalPreparedOperation[]
): Promise<WalRecord> {
  await fs.mkdir(walDir, { recursive: true });
  const record: WalRecord = {
    schemaVersion: "1.0",
    txId,
    state: "prepared",
    preparedAt: new Date().toISOString(),
    operations
  };
  await writeFileAtomic(walFilePath(walDir, txId), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function markWalCommitted(walDir: string, record: WalRecord): Promise<WalRecord> {
  const committed: WalRecord = {
    ...record,
    state: "committed",
    committedAt: new Date().toISOString()
  };
  await writeFileAtomic(walFilePath(walDir, record.txId), `${JSON.stringify(committed, null, 2)}\n`);
  return committed;
}

export async function removeWalRecord(walDir: string, txId: string): Promise<void> {
  await fs.rm(walFilePath(walDir, txId), { force: true });
}

export async function listWalRecords(walDir: string): Promise<WalRecord[]> {
  let entries: Dirent[] = [];
  try {
    entries = await retryWalReadOperation({
      walDir,
      operation: "readdir",
      execute: () => fs.readdir(walDir, { withFileTypes: true })
    });
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".wal.json"))
    .map((entry) => path.join(walDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
  const records: WalRecord[] = [];
  for (const file of files) {
    try {
      const raw = await retryWalReadOperation({
        walDir,
        walFile: file,
        operation: "readFile",
        execute: () => fs.readFile(file, "utf8")
      });
      const parsed = JSON.parse(raw) as WalRecord;
      records.push(parsed);
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      // Another transaction may remove a WAL record between readdir and read.
      if (known.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return records;
}

function isTransientWalReadError(error: unknown): boolean {
  const known = error as NodeJS.ErrnoException;
  return Boolean(known.code && TRANSIENT_WAL_READ_ERROR_CODES.has(known.code));
}

async function retryWalReadOperation<T>(input: {
  walDir: string;
  walFile?: string;
  operation: "readdir" | "readFile";
  execute: () => Promise<T>;
}): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= WAL_READ_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await input.execute();
    } catch (error) {
      lastError = error;
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        throw error;
      }
      if (!isTransientWalReadError(error) || attempt >= WAL_READ_MAX_ATTEMPTS) {
        break;
      }
      await delayMs(backoffDelayMs(attempt));
    }
  }

  const known = lastError as NodeJS.ErrnoException;
  const details: Record<string, unknown> = {
    operation: input.operation,
    walDir: path.resolve(input.walDir),
    walFile: input.walFile ? path.resolve(input.walFile) : null,
    attempts: WAL_READ_MAX_ATTEMPTS,
    errorCode: known?.code ?? "UNKNOWN",
    errorMessage: known?.message ?? String(lastError ?? "unknown_error")
  };
  throw new StorageAccessError(
    `WAL ${input.operation} failed after ${WAL_READ_MAX_ATTEMPTS} attempts`,
    details
  );
}

function backoffDelayMs(attempt: number): number {
  const candidate = WAL_READ_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(WAL_READ_MAX_DELAY_MS, candidate);
}

async function delayMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
