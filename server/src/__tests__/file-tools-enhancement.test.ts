import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import {
  EditFileTool,
  GlobTool,
  GrepTool,
  ReadFileTool,
  WebFetchTool,
  WebSearchTool,
  WriteFileTool
} from "../minimax/tools/FileTools.js";

test("ReadFileTool supports offset and limit line slicing", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "autodev-read-offset-"));
  const filePath = path.join(workspaceDir, "sample.txt");
  await writeFile(filePath, ["line-1", "line-2", "line-3", "line-4", "line-5"].join("\n"), "utf-8");

  const tool = new ReadFileTool({ workspaceDir });
  const result = await tool.execute({
    path: "sample.txt",
    offset: 1,
    limit: 2
  });
  assert.equal(result.success, true);
  assert.equal(result.content, "line-2\nline-3");
});

test("GrepTool searches content and returns file:line:text rows", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "autodev-grep-tool-"));
  const filePath = path.join(workspaceDir, "demo.ts");
  await writeFile(filePath, ["const A = 1;", "const targetValue = 2;", "const B = targetValue;"].join("\n"), "utf-8");

  const tool = new GrepTool({ workspaceDir });
  const result = await tool.execute({
    pattern: "targetValue",
    path: ".",
    include: ["*.ts"]
  });
  assert.equal(result.success, true);
  assert.equal(result.content.includes("demo.ts:2:const targetValue = 2;"), true);
  assert.equal(result.content.includes("demo.ts:3:const B = targetValue;"), true);
});

test("WriteFileTool writes file content and creates nested directories", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "autodev-write-tool-"));
  const tool = new WriteFileTool({ workspaceDir });
  const result = await tool.execute({
    path: "src/nested/new-file.txt",
    content: "hello-write-tool"
  });
  assert.equal(result.success, true);
  const actual = await readFile(path.join(workspaceDir, "src", "nested", "new-file.txt"), "utf-8");
  assert.equal(actual, "hello-write-tool");
});

test("EditFileTool replaces target text and reports error when oldStr is missing", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "autodev-edit-tool-"));
  const filePath = path.join(workspaceDir, "doc.md");
  await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf-8");
  const tool = new EditFileTool({ workspaceDir });

  const success = await tool.execute({
    path: "doc.md",
    oldStr: "beta",
    newStr: "beta-updated"
  });
  assert.equal(success.success, true);
  const edited = await readFile(filePath, "utf-8");
  assert.equal(edited.includes("beta-updated"), true);

  const failed = await tool.execute({
    path: "doc.md",
    oldStr: "not-found-token",
    newStr: "x"
  });
  assert.equal(failed.success, false);
  assert.equal(Boolean(failed.error?.includes("Text not found in file")), true);
});

test("GlobTool finds matching files under nested directories", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "autodev-glob-tool-"));
  await mkdir(path.join(workspaceDir, "sub"), { recursive: true });
  await writeFile(path.join(workspaceDir, "a.ts"), "export const a = 1;", "utf-8");
  await writeFile(path.join(workspaceDir, "sub", "b.ts"), "export const b = 2;", "utf-8");
  await writeFile(path.join(workspaceDir, "sub", "c.md"), "# note", "utf-8");

  const tool = new GlobTool({ workspaceDir });
  const nestedDir = await tool.execute({
    pattern: "*.ts",
    path: "sub"
  });
  assert.equal(nestedDir.success, true);
  assert.equal(nestedDir.content.includes("b.ts"), true);
  assert.equal(nestedDir.content.includes("c.md"), false);

  const rootOnly = await tool.execute({
    pattern: "*.ts",
    path: "."
  });
  assert.equal(rootOnly.success, true);
  assert.equal(rootOnly.content.includes("a.ts"), true);
});

test("GrepTool respects max_results limit", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "autodev-grep-limit-tool-"));
  const filePath = path.join(workspaceDir, "sample.ts");
  await writeFile(
    filePath,
    ["target one", "target two", "target three", "target four"].join("\n"),
    "utf-8"
  );
  const tool = new GrepTool({ workspaceDir });
  const result = await tool.execute({
    pattern: "target",
    path: ".",
    include: "*.ts",
    max_results: 2
  });
  assert.equal(result.success, true);
  const lines = result.content.split("\n").filter((line) => line.trim().length > 0);
  assert.equal(lines.length, 2);
});

test("WebFetchTool returns fetched text and handles HTTP failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("ok.example")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "text/plain" },
        text: async () => "ok-body",
        json: async () => ({ ok: true })
      } as unknown as Response;
    }
    return {
      ok: false,
      status: 500,
      statusText: "Server Error",
      headers: { get: () => null },
      text: async () => "",
      json: async () => ({})
    } as unknown as Response;
  }) as typeof fetch;

  try {
    const tool = new WebFetchTool();
    const ok = await tool.execute({ url: "https://ok.example/path", format: "text" });
    assert.equal(ok.success, true);
    assert.equal(ok.content.includes("ok-body"), true);

    const failed = await tool.execute({ url: "https://err.example/path", format: "text" });
    assert.equal(failed.success, false);
    assert.equal(Boolean(failed.error?.includes("HTTP 500")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WebSearchTool parses search payload into list output", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "application/json" },
      json: async () => ({
        AbstractText: "Primary result summary",
        AbstractURL: "https://example.com/primary",
        RelatedTopics: [
          { Text: "Related A", FirstURL: "https://example.com/a" },
          { Text: "Related B", FirstURL: "https://example.com/b" }
        ]
      }),
      text: async () => ""
    } as unknown as Response;
  }) as typeof fetch;

  try {
    const tool = new WebSearchTool();
    const result = await tool.execute({ query: "task graph", num_results: 2 });
    assert.equal(result.success, true);
    assert.equal(result.content.includes("Primary result summary"), true);
    assert.equal(result.content.includes("https://example.com/primary"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
