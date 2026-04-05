import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import {
  appendJsonlLine,
  deleteDirectoryTransactional,
  readJsonFile,
  readJsonlLines,
  runStorageTransaction,
  writeJsonFile
} from "../data/file-utils.js";
import { rollbackPreparedOperation } from "../data/storage/recovery-runner.js";

test("runStorageTransaction rolls back staged writes when callback throws", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-storage-tx-rollback-"));
  const jsonFile = path.join(tempRoot, "state.json");
  const jsonlFile = path.join(tempRoot, "events.jsonl");

  await writeJsonFile(jsonFile, { value: "before" });

  await assert.rejects(async () => {
    await runStorageTransaction([jsonFile, jsonlFile], async () => {
      await writeJsonFile(jsonFile, { value: "after" });
      await appendJsonlLine(jsonlFile, { event: "A" });
      throw new Error("force rollback");
    });
  });

  const current = await readJsonFile<{ value: string }>(jsonFile, { value: "missing" });
  const events = await readJsonlLines<{ event: string }>(jsonlFile);
  assert.equal(current.value, "before");
  assert.equal(events.length, 0);
});

test("deleteDirectoryTransactional removes directory atomically", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-storage-tx-delete-"));
  const target = path.join(tempRoot, "target-dir");
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "file.txt"), "payload", "utf8");

  await deleteDirectoryTransactional(target);

  await assert.rejects(async () => fs.access(target), {
    code: "ENOENT"
  });
});

test("append rollback does not expand file with zero bytes when current file is already smaller", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-storage-tx-append-rollback-"));
  const logFile = path.join(tempRoot, "events.jsonl");
  await fs.writeFile(logFile, "abc", "utf8");

  await rollbackPreparedOperation({
    type: "appendJsonl",
    filePath: logFile,
    line: '{"event":"probe"}\n',
    previousSize: 16
  });

  const bytes = await fs.readFile(logFile);
  assert.equal(bytes.length, 3);
  assert.equal(bytes.includes(0), false);
  assert.equal(bytes.toString("utf8"), "abc");
});
