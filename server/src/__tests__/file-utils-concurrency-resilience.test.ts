import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { readJsonFile, readJsonlLines } from "../data/file-utils.js";

test("readJsonlLines keeps valid prefix when last line is half-written", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-file-utils-jsonl-tail-"));
  const target = path.join(tempRoot, "events.jsonl");
  await writeFile(target, '{"id":1}\n{"id":2', "utf8");

  const rows = await readJsonlLines<{ id: number }>(target);
  assert.deepEqual(rows, [{ id: 1 }]);
});

test("readJsonlLines still throws on malformed non-tail line", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-file-utils-jsonl-bad-"));
  const target = path.join(tempRoot, "events.jsonl");
  await writeFile(target, '{"id":1\n{"id":2}\n', "utf8");

  await assert.rejects(() => readJsonlLines<{ id: number }>(target), {
    name: "SyntaxError"
  });
});

test("readJsonFile retries transient truncated content", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-file-utils-json-retry-"));
  const target = path.join(tempRoot, "state.json");
  await writeFile(target, '{"ok":', "utf8");

  setTimeout(() => {
    void writeFile(target, '{"ok":true}\n', "utf8");
  }, 8);

  const result = await readJsonFile<{ ok: boolean }>(target, { ok: false });
  assert.equal(result.ok, true);
});
