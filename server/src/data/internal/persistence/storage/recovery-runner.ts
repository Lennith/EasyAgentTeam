import fs from "node:fs/promises";
import path from "node:path";
import { truncateFileAtomic, writeFileAtomic } from "./atomic-writer.js";
import { withFileLocks } from "./file-lock-registry.js";
import {
  listWalRecords,
  removeWalRecord,
  withWalDirectoryLock,
  type WalPreparedOperation,
  type WalRecord
} from "./wal-store.js";

function lockPathsForOperation(operation: WalPreparedOperation): string[] {
  switch (operation.type) {
    case "putJson":
    case "overwriteJsonl":
    case "appendJsonl":
      return lockPathWithAncestors(operation.filePath, 2);
    case "mkdir":
      return lockPathWithAncestors(operation.dirPath, 2);
    case "renameDir":
      return [...lockPathWithAncestors(operation.sourcePath, 2), ...lockPathWithAncestors(operation.targetPath, 2)];
    case "deleteDir":
      return [...lockPathWithAncestors(operation.dirPath, 2), ...lockPathWithAncestors(operation.trashPath, 2)];
    case "deleteFile":
      return [...lockPathWithAncestors(operation.filePath, 2), ...lockPathWithAncestors(operation.trashPath, 2)];
    default:
      return [];
  }
}

function lockPathsForRecord(record: WalRecord): string[] {
  return Array.from(new Set(record.operations.flatMap((item) => lockPathsForOperation(item))));
}

export async function applyPreparedOperation(operation: WalPreparedOperation): Promise<void> {
  switch (operation.type) {
    case "putJson":
    case "overwriteJsonl": {
      await writeFileAtomic(operation.filePath, operation.nextContent);
      return;
    }
    case "appendJsonl": {
      await fs.mkdir(path.dirname(operation.filePath), { recursive: true });
      await fs.appendFile(operation.filePath, operation.line, "utf8");
      return;
    }
    case "mkdir": {
      await fs.mkdir(operation.dirPath, { recursive: true });
      return;
    }
    case "renameDir": {
      if (!operation.sourceExisted) {
        return;
      }
      await fs.rename(operation.sourcePath, operation.targetPath);
      return;
    }
    case "deleteDir": {
      if (!operation.sourceExisted) {
        return;
      }
      await fs.mkdir(path.dirname(operation.trashPath), { recursive: true });
      await fs.rename(operation.dirPath, operation.trashPath);
      return;
    }
    case "deleteFile": {
      if (!operation.sourceExisted) {
        return;
      }
      await fs.mkdir(path.dirname(operation.trashPath), { recursive: true });
      await fs.rename(operation.filePath, operation.trashPath);
      return;
    }
    default:
      return;
  }
}

export async function rollbackPreparedOperation(operation: WalPreparedOperation): Promise<void> {
  switch (operation.type) {
    case "putJson":
    case "overwriteJsonl": {
      if (operation.previousContent === null) {
        await fs.rm(operation.filePath, { force: true });
      } else {
        await writeFileAtomic(operation.filePath, operation.previousContent);
      }
      return;
    }
    case "appendJsonl": {
      if (operation.previousSize === null) {
        await fs.rm(operation.filePath, { force: true });
        return;
      }
      try {
        await fs.access(operation.filePath);
      } catch (error) {
        const known = error as NodeJS.ErrnoException;
        if (known.code === "ENOENT") {
          return;
        }
        throw error;
      }
      const stat = await fs.stat(operation.filePath);
      const currentSize = stat.size;
      if (currentSize <= operation.previousSize) {
        // Rollback for append must never expand file size; expansion introduces zero-filled gaps.
        return;
      }
      await truncateFileAtomic(operation.filePath, operation.previousSize);
      return;
    }
    case "mkdir": {
      if (!operation.existedBefore) {
        await fs.rm(operation.dirPath, { recursive: true, force: true });
      }
      return;
    }
    case "renameDir": {
      if (!operation.sourceExisted) {
        return;
      }
      try {
        await fs.access(operation.targetPath);
      } catch (error) {
        const known = error as NodeJS.ErrnoException;
        if (known.code === "ENOENT") {
          return;
        }
        throw error;
      }
      await fs.rename(operation.targetPath, operation.sourcePath);
      return;
    }
    case "deleteDir": {
      if (!operation.sourceExisted) {
        return;
      }
      try {
        await fs.access(operation.trashPath);
      } catch (error) {
        const known = error as NodeJS.ErrnoException;
        if (known.code === "ENOENT") {
          return;
        }
        throw error;
      }
      await fs.rename(operation.trashPath, operation.dirPath);
      return;
    }
    case "deleteFile": {
      if (!operation.sourceExisted) {
        return;
      }
      try {
        await fs.access(operation.trashPath);
      } catch (error) {
        const known = error as NodeJS.ErrnoException;
        if (known.code === "ENOENT") {
          return;
        }
        throw error;
      }
      await fs.mkdir(path.dirname(operation.filePath), { recursive: true });
      await fs.rename(operation.trashPath, operation.filePath);
      return;
    }
    default:
      return;
  }
}

export async function finalizeCommittedOperation(operation: WalPreparedOperation): Promise<void> {
  if (operation.type === "deleteDir") {
    await fs.rm(operation.trashPath, { recursive: true, force: true });
  }
  if (operation.type === "deleteFile") {
    await fs.rm(operation.trashPath, { force: true });
  }
}

const recoveryStates = new Map<string, Promise<void>>();

export async function recoverWalDirectory(walDir: string): Promise<void> {
  const existing = recoveryStates.get(walDir);
  if (existing) {
    return existing;
  }
  const running = withWalDirectoryLock(walDir, () => recoverWalDirectoryInternal(walDir)).finally(() => {
    recoveryStates.delete(walDir);
  });
  recoveryStates.set(walDir, running);
  return running;
}

async function recoverWalDirectoryInternal(walDir: string): Promise<void> {
  const records = await listWalRecords(walDir);
  for (const record of records) {
    const locks = lockPathsForRecord(record);
    await withFileLocks(locks, async () => {
      if (record.state === "prepared") {
        for (let i = record.operations.length - 1; i >= 0; i -= 1) {
          await rollbackPreparedOperation(record.operations[i]);
        }
      } else {
        for (const operation of record.operations) {
          await finalizeCommittedOperation(operation);
        }
      }
      await removeWalRecord(walDir, record.txId);
    });
  }
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
