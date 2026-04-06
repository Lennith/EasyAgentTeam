import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs, { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { listWalRecords, StorageAccessError } from "../data/internal/persistence/storage/wal-store.js";

function createErrnoError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test("listWalRecords retries transient EPERM on wal file read", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-wal-read-retry-"));
  const walDir = path.join(tempRoot, ".storage-wal");
  const walFile = path.join(walDir, "tx-1.wal.json");
  await mkdir(walDir, { recursive: true });
  await writeFile(
    walFile,
    `${JSON.stringify(
      {
        schemaVersion: "1.0",
        txId: "tx-1",
        state: "committed",
        preparedAt: new Date().toISOString(),
        committedAt: new Date().toISOString(),
        operations: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const originalReadFile = fs.readFile;
  let remainingFailures = 2;
  fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    const target = String(args[0]);
    if (target === walFile && remainingFailures > 0) {
      remainingFailures -= 1;
      throw createErrnoError("EPERM", "simulated transient wal read failure");
    }
    return originalReadFile(...args);
  }) as typeof fs.readFile;

  try {
    const records = await listWalRecords(walDir);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.txId, "tx-1");
    assert.equal(remainingFailures, 0);
  } finally {
    fs.readFile = originalReadFile;
  }
});

test("listWalRecords retries transient EPERM on wal directory scan", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-wal-readdir-retry-"));
  const walDir = path.join(tempRoot, ".storage-wal");
  await mkdir(walDir, { recursive: true });

  const originalReaddir = fs.readdir;
  let remainingFailures = 2;
  fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
    const target = String(args[0]);
    if (target === walDir && remainingFailures > 0) {
      remainingFailures -= 1;
      throw createErrnoError("EPERM", "simulated transient wal readdir failure");
    }
    return originalReaddir(...args);
  }) as typeof fs.readdir;

  try {
    const records = await listWalRecords(walDir);
    assert.equal(Array.isArray(records), true);
    assert.equal(records.length, 0);
    assert.equal(remainingFailures, 0);
  } finally {
    fs.readdir = originalReaddir;
  }
});

test("listWalRecords throws StorageAccessError when wal file remains unreadable", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-wal-read-fail-"));
  const walDir = path.join(tempRoot, ".storage-wal");
  const walFile = path.join(walDir, "tx-fail.wal.json");
  await mkdir(walDir, { recursive: true });
  await writeFile(
    walFile,
    `${JSON.stringify(
      {
        schemaVersion: "1.0",
        txId: "tx-fail",
        state: "prepared",
        preparedAt: new Date().toISOString(),
        operations: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const originalReadFile = fs.readFile;
  fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    const target = String(args[0]);
    if (target === walFile) {
      throw createErrnoError("EPERM", "simulated persistent wal read failure");
    }
    return originalReadFile(...args);
  }) as typeof fs.readFile;

  try {
    await assert.rejects(
      () => listWalRecords(walDir),
      (error: unknown) => {
        assert.equal(error instanceof StorageAccessError, true);
        const typed = error as StorageAccessError;
        assert.equal(typed.code, "STORAGE_TEMPORARILY_UNAVAILABLE");
        assert.equal(String(typed.details.operation), "readFile");
        assert.equal(String(typed.details.errorCode), "EPERM");
        assert.equal(Number(typed.details.attempts) > 1, true);
        assert.equal(String(typed.details.walFile), path.resolve(walFile));
        return true;
      }
    );
  } finally {
    fs.readFile = originalReadFile;
  }
});
