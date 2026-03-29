import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { createRepository, createUnitOfWork } from "../data/repository/runtime.js";

test("repository file backend keeps json/jsonl semantics with unit-of-work", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-repository-file-"));
  const repository = createRepository("file");
  const unitOfWork = createUnitOfWork("file");

  const jsonFile = path.join(tempRoot, "state", "sample.json");
  const jsonDir = path.dirname(jsonFile);
  const jsonFallback = { schemaVersion: "missing", value: -1 };

  await repository.ensureDirectory(jsonDir);
  await repository.ensureFile(jsonFile, `${JSON.stringify({ schemaVersion: "1.0", value: 0 }, null, 2)}\n`);

  const seeded = await repository.readJson(jsonFile, jsonFallback);
  assert.equal(seeded.schemaVersion, "1.0");
  assert.equal(seeded.value, 0);

  await unitOfWork.run([jsonFile], async () => {
    await repository.writeJson(jsonFile, { schemaVersion: "1.0", value: 1 });
  });

  const updated = await repository.readJson(jsonFile, jsonFallback);
  assert.equal(updated.value, 1);

  const logFile = path.join(tempRoot, "events.jsonl");
  await repository.appendJsonl(logFile, { eventType: "A" });
  await repository.appendJsonl(logFile, { eventType: "B" });
  const appended = await repository.readJsonl<{ eventType: string }>(logFile);
  assert.deepEqual(
    appended.map((item) => item.eventType),
    ["A", "B"]
  );

  await repository.writeJsonl(logFile, [{ eventType: "C" }]);
  const overwritten = await repository.readJsonl<{ eventType: string }>(logFile);
  assert.deepEqual(
    overwritten.map((item) => item.eventType),
    ["C"]
  );

  const files = await repository.listFiles(jsonDir);
  assert.equal(files.includes(path.resolve(jsonFile)), true);

  await repository.deleteFile(jsonFile);
  const afterDelete = await repository.readJson(jsonFile, jsonFallback);
  assert.deepEqual(afterDelete, jsonFallback);
});

test("repository memory backend keeps json/jsonl semantics with unit-of-work", async () => {
  const repository = createRepository("memory");
  const unitOfWork = createUnitOfWork("memory");

  const jsonFile = path.join("virtual", "project", "state", "sample.json");
  const jsonDir = path.dirname(jsonFile);
  const fallback = { schemaVersion: "fallback", value: -1 };

  await repository.ensureDirectory(jsonDir);
  await repository.ensureFile(jsonFile, `${JSON.stringify({ schemaVersion: "1.0", value: 0 }, null, 2)}\n`);

  const seeded = await repository.readJson(jsonFile, fallback);
  assert.equal(seeded.schemaVersion, "1.0");
  assert.equal(seeded.value, 0);

  await unitOfWork.run([jsonFile], async () => {
    await repository.writeJson(jsonFile, { schemaVersion: "1.0", value: 2 });
  });

  const updated = await repository.readJson(jsonFile, fallback);
  assert.equal(updated.value, 2);

  const logFile = path.join("virtual", "project", "events.jsonl");
  await repository.appendJsonl(logFile, { eventType: "A" });
  await repository.appendJsonl(logFile, { eventType: "B" });
  const appended = await repository.readJsonl<{ eventType: string }>(logFile);
  assert.deepEqual(
    appended.map((item) => item.eventType),
    ["A", "B"]
  );

  await repository.writeJsonl(logFile, [{ eventType: "C" }]);
  const overwritten = await repository.readJsonl<{ eventType: string }>(logFile);
  assert.deepEqual(
    overwritten.map((item) => item.eventType),
    ["C"]
  );

  const files = await repository.listFiles(jsonDir);
  assert.equal(files.includes(path.resolve(jsonFile)), true);

  await repository.deleteFile(jsonFile);
  const afterDelete = await repository.readJson(jsonFile, fallback);
  assert.deepEqual(afterDelete, fallback);
});
