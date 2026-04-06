import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import type { StorageTransaction } from "../store/store-interface.js";
import { withFileLocks } from "./file-lock-registry.js";
import {
  applyPreparedOperation,
  finalizeCommittedOperation,
  recoverWalDirectory,
  rollbackPreparedOperation
} from "./recovery-runner.js";
import {
  listWalRecords,
  markWalCommitted,
  removeWalRecord,
  withWalDirectoryLock,
  writeWalPrepare,
  type WalPreparedOperation
} from "./wal-store.js";

interface StagedPutJsonOperation {
  type: "putJson";
  filePath: string;
  serializedContent: string;
}

interface StagedOverwriteJsonlOperation {
  type: "overwriteJsonl";
  filePath: string;
  content: string;
}

interface StagedAppendJsonlOperation {
  type: "appendJsonl";
  filePath: string;
  line: string;
}

interface StagedMkdirOperation {
  type: "mkdir";
  dirPath: string;
}

interface StagedRenameDirOperation {
  type: "renameDir";
  sourcePath: string;
  targetPath: string;
}

interface StagedDeleteDirOperation {
  type: "deleteDir";
  dirPath: string;
}

interface StagedDeleteFileOperation {
  type: "deleteFile";
  filePath: string;
}

type StagedOperation =
  | StagedPutJsonOperation
  | StagedOverwriteJsonlOperation
  | StagedAppendJsonlOperation
  | StagedMkdirOperation
  | StagedRenameDirOperation
  | StagedDeleteDirOperation
  | StagedDeleteFileOperation;

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readUtf8OrNull(targetPath: string): Promise<string | null> {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function fileSizeOrNull(targetPath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.size;
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function lockPathsForStagedOperation(operation: StagedOperation): string[] {
  switch (operation.type) {
    case "putJson":
    case "overwriteJsonl":
    case "appendJsonl":
      return lockPathWithAncestors(operation.filePath, 2);
    case "mkdir":
      return lockPathWithAncestors(operation.dirPath, 2);
    case "renameDir":
      return [
        ...lockPathWithAncestors(operation.sourcePath, 2),
        ...lockPathWithAncestors(operation.targetPath, 2)
      ];
    case "deleteDir":
      return [
        ...lockPathWithAncestors(operation.dirPath, 2),
        ...lockPathWithAncestors(trashDirForDelete(operation.dirPath), 2)
      ];
    case "deleteFile":
      return [
        ...lockPathWithAncestors(operation.filePath, 2),
        ...lockPathWithAncestors(trashDirForDelete(operation.filePath), 2)
      ];
    default:
      return [];
  }
}

function lockPathsForStagedOperations(operations: StagedOperation[]): string[] {
  return Array.from(new Set(operations.flatMap((item) => lockPathsForStagedOperation(item))));
}

function lockPathsForPreparedOperations(operations: WalPreparedOperation[]): string[] {
  return Array.from(
    new Set(
      operations.flatMap((operation) => {
        switch (operation.type) {
          case "putJson":
          case "overwriteJsonl":
          case "appendJsonl":
            return lockPathWithAncestors(operation.filePath, 2);
          case "mkdir":
            return lockPathWithAncestors(operation.dirPath, 2);
          case "renameDir":
            return [
              ...lockPathWithAncestors(operation.sourcePath, 2),
              ...lockPathWithAncestors(operation.targetPath, 2)
            ];
          case "deleteDir":
            return [
              ...lockPathWithAncestors(operation.dirPath, 2),
              ...lockPathWithAncestors(operation.trashPath, 2)
            ];
          case "deleteFile":
            return [
              ...lockPathWithAncestors(operation.filePath, 2),
              ...lockPathWithAncestors(operation.trashPath, 2)
            ];
          default:
            return [];
        }
      })
    )
  );
}

function lockPathWithAncestors(targetPath: string, maxAncestors: number): string[] {
  const normalized = path.resolve(targetPath);
  const result = [normalized];
  let cursor = normalized;
  for (let i = 0; i < maxAncestors; i += 1) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    result.push(parent);
    cursor = parent;
  }
  return result;
}

function trashDirForDelete(dirPath: string): string {
  return path.join(path.dirname(dirPath), ".storage-trash");
}

function buildDeleteTrashPath(dirPath: string, txId: string): string {
  const baseName = path.basename(dirPath);
  const suffix = randomUUID().slice(0, 8);
  return path.join(trashDirForDelete(dirPath), `${baseName}.${txId}.${suffix}`);
}

async function prepareOperation(operation: StagedOperation, txId: string): Promise<WalPreparedOperation> {
  switch (operation.type) {
    case "putJson":
      return {
        type: "putJson",
        filePath: operation.filePath,
        nextContent: operation.serializedContent,
        previousContent: await readUtf8OrNull(operation.filePath)
      };
    case "overwriteJsonl":
      return {
        type: "overwriteJsonl",
        filePath: operation.filePath,
        nextContent: operation.content,
        previousContent: await readUtf8OrNull(operation.filePath)
      };
    case "appendJsonl":
      return {
        type: "appendJsonl",
        filePath: operation.filePath,
        line: operation.line,
        previousSize: await fileSizeOrNull(operation.filePath)
      };
    case "mkdir":
      return {
        type: "mkdir",
        dirPath: operation.dirPath,
        existedBefore: await exists(operation.dirPath)
      };
    case "renameDir":
      return {
        type: "renameDir",
        sourcePath: operation.sourcePath,
        targetPath: operation.targetPath,
        sourceExisted: await exists(operation.sourcePath),
        targetExisted: await exists(operation.targetPath)
      };
    case "deleteDir":
      return {
        type: "deleteDir",
        dirPath: operation.dirPath,
        trashPath: buildDeleteTrashPath(operation.dirPath, txId),
        sourceExisted: await exists(operation.dirPath)
      };
    case "deleteFile":
      return {
        type: "deleteFile",
        filePath: operation.filePath,
        trashPath: buildDeleteTrashPath(operation.filePath, txId),
        sourceExisted: await exists(operation.filePath)
      };
    default:
      throw new Error("Unknown staged operation type");
  }
}

class StorageTransactionImpl implements StorageTransaction {
  private readonly txId = randomUUID();
  private readonly operations: StagedOperation[] = [];
  private readonly pendingFileContent = new Map<string, string>();
  private finished = false;

  constructor(private walDir: string) {}

  addPaths(paths: string[]): void {
    if (this.operations.length > 0) {
      return;
    }
    const candidate = deriveWalDirFromPaths(paths);
    if (candidate !== this.walDir) {
      this.walDir = candidate;
    }
  }

  async putJson(filePath: string, serializedContent: string): Promise<void> {
    this.assertActive();
    const normalized = path.resolve(filePath);
    this.operations.push({
      type: "putJson",
      filePath: normalized,
      serializedContent
    });
    this.pendingFileContent.set(normalized, serializedContent);
  }

  async overwriteJsonl(filePath: string, content: string): Promise<void> {
    this.assertActive();
    const normalized = path.resolve(filePath);
    this.operations.push({
      type: "overwriteJsonl",
      filePath: normalized,
      content
    });
    this.pendingFileContent.set(normalized, content);
  }

  async appendJsonl(filePath: string, line: string): Promise<void> {
    this.assertActive();
    const normalized = path.resolve(filePath);
    this.operations.push({
      type: "appendJsonl",
      filePath: normalized,
      line
    });
    const pending = this.pendingFileContent.get(normalized);
    if (pending !== undefined) {
      this.pendingFileContent.set(normalized, `${pending}${line}`);
      return;
    }
    const existing = await readUtf8OrNull(normalized);
    this.pendingFileContent.set(normalized, `${existing ?? ""}${line}`);
  }

  async mkdir(dirPath: string): Promise<void> {
    this.assertActive();
    this.operations.push({
      type: "mkdir",
      dirPath: path.resolve(dirPath)
    });
  }

  async renameDir(sourcePath: string, targetPath: string): Promise<void> {
    this.assertActive();
    const normalizedSource = path.resolve(sourcePath);
    const normalizedTarget = path.resolve(targetPath);
    this.operations.push({
      type: "renameDir",
      sourcePath: normalizedSource,
      targetPath: normalizedTarget
    });
    this.remapPendingByDirectoryRename(normalizedSource, normalizedTarget);
  }

  async deleteDir(dirPath: string): Promise<void> {
    this.assertActive();
    const normalized = path.resolve(dirPath);
    this.operations.push({
      type: "deleteDir",
      dirPath: normalized
    });
    this.deletePendingByDirectory(normalized);
  }

  async deleteFile(filePath: string): Promise<void> {
    this.assertActive();
    const normalized = path.resolve(filePath);
    this.operations.push({
      type: "deleteFile",
      filePath: normalized
    });
    this.pendingFileContent.delete(normalized);
  }

  async commit(): Promise<void> {
    this.assertActive();
    this.finished = true;
    if (this.operations.length === 0) {
      return;
    }

    await recoverWalDirectory(this.walDir);
    const operationLocks = lockPathsForStagedOperations(this.operations);
    await withWalDirectoryLock(this.walDir, async () => {
      await withFileLocks(operationLocks, async () => {
        const preparedOperations: WalPreparedOperation[] = [];
        for (const operation of this.operations) {
          preparedOperations.push(await prepareOperation(operation, this.txId));
        }

        const walRecord = await writeWalPrepare(this.walDir, this.txId, preparedOperations);
        const applied: WalPreparedOperation[] = [];
        try {
          for (const operation of preparedOperations) {
            await applyPreparedOperation(operation);
            applied.push(operation);
          }
        } catch (error) {
          let rollbackFailed = false;
          for (let i = applied.length - 1; i >= 0; i -= 1) {
            try {
              await rollbackPreparedOperation(applied[i]);
            } catch {
              rollbackFailed = true;
            }
          }
          if (!rollbackFailed) {
            await removeWalRecord(this.walDir, this.txId);
          }
          throw error;
        }

        const committedRecord = await markWalCommitted(this.walDir, walRecord);
        const cleanupErrors: unknown[] = [];
        for (const operation of committedRecord.operations) {
          try {
            await finalizeCommittedOperation(operation);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (cleanupErrors.length === 0) {
          await removeWalRecord(this.walDir, this.txId);
        }
      });
    });
  }

  async rollback(): Promise<void> {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.operations.length = 0;
    this.pendingFileContent.clear();
  }

  getPendingFileContent(filePath: string): string | undefined {
    return this.pendingFileContent.get(path.resolve(filePath));
  }

  private deletePendingByDirectory(dirPath: string): void {
    const normalizedDir = withTrailingSeparator(dirPath);
    for (const key of this.pendingFileContent.keys()) {
      if (withTrailingSeparator(key).startsWith(normalizedDir)) {
        this.pendingFileContent.delete(key);
      }
    }
  }

  private remapPendingByDirectoryRename(sourceDir: string, targetDir: string): void {
    const normalizedSource = withTrailingSeparator(sourceDir);
    for (const [key, value] of Array.from(this.pendingFileContent.entries())) {
      const normalizedKey = withTrailingSeparator(key);
      if (!normalizedKey.startsWith(normalizedSource)) {
        continue;
      }
      const relative = key.slice(sourceDir.length).replace(/^[\\/]+/, "");
      const targetKey = path.join(targetDir, relative);
      this.pendingFileContent.delete(key);
      this.pendingFileContent.set(path.resolve(targetKey), value);
    }
  }

  private assertActive(): void {
    if (this.finished) {
      throw new Error("Storage transaction already finished");
    }
  }
}

const transactionContext = new AsyncLocalStorage<StorageTransactionImpl>();

export function getActiveStorageTransaction(): StorageTransaction | null {
  return transactionContext.getStore() ?? null;
}

export function getActiveTransactionPendingFileContent(filePath: string): string | undefined {
  return transactionContext.getStore()?.getPendingFileContent(filePath);
}

export async function withStorageTransaction<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
  const existing = transactionContext.getStore();
  if (existing) {
    existing.addPaths(paths);
    return operation();
  }

  const walDir = deriveWalDirFromPaths(paths);
  const transaction = new StorageTransactionImpl(walDir);
  transaction.addPaths(paths);
  return transactionContext.run(transaction, async () => {
    try {
      const result = await operation();
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  });
}

const walRecoveryByDir = new Map<string, Promise<void>>();

export async function ensureStorageRecoveryForPaths(paths: string[]): Promise<void> {
  const walDir = deriveWalDirFromPaths(paths);
  const existing = walRecoveryByDir.get(walDir);
  if (existing) {
    return existing;
  }
  const running = recoverWalDirectory(walDir).finally(() => {
    walRecoveryByDir.delete(walDir);
  });
  walRecoveryByDir.set(walDir, running);
  return running;
}

export async function cleanupCommittedWalRecordsForPaths(paths: string[]): Promise<void> {
  const walDir = deriveWalDirFromPaths(paths);
  await withWalDirectoryLock(walDir, async () => {
    const records = await listWalRecords(walDir);
    for (const record of records) {
      if (record.state !== "committed") {
        continue;
      }
      await withFileLocks(lockPathsForPreparedOperations(record.operations), async () => {
        for (const operation of record.operations) {
          await finalizeCommittedOperation(operation);
        }
        await removeWalRecord(walDir, record.txId);
      });
    }
  });
}

function deriveWalDirFromPaths(paths: string[]): string {
  const normalized = paths.map((item) => path.resolve(item)).filter((item) => item.length > 0);
  if (normalized.length === 0) {
    return path.join(process.cwd(), ".storage-wal");
  }
  let common = normalized[0];
  for (let i = 1; i < normalized.length; i += 1) {
    common = commonAncestor(common, normalized[i]);
  }
  const statHintExt = path.extname(common);
  const walRoot = statHintExt.length > 0 ? path.dirname(common) : common;
  return path.join(walRoot, ".storage-wal");
}

function commonAncestor(left: string, right: string): string {
  let candidate = left;
  while (!isSubPath(right, candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return parent;
    }
    candidate = parent;
  }
  return candidate;
}

function isSubPath(target: string, parent: string): boolean {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function withTrailingSeparator(input: string): string {
  const normalized = path.resolve(input);
  return normalized.endsWith(path.sep) ? normalized : `${normalized}${path.sep}`;
}
