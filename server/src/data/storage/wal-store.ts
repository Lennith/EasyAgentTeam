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
    entries = await fs.readdir(walDir, { withFileTypes: true });
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
      const raw = await fs.readFile(file, "utf8");
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
