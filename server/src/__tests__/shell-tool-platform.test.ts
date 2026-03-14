import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createShellTool } from "../minimax/tools/ShellTool.js";

test("shell tool exposes only supported shells for current host platform", () => {
  const tool = createShellTool({
    workspaceDir: process.cwd()
  });
  const parameters = tool.parameters as {
    properties?: {
      shell?: {
        enum?: string[];
      };
    };
  };
  const shellEnum = parameters.properties?.shell?.enum ?? [];

  if (process.platform === "win32") {
    assert.deepEqual(shellEnum, ["powershell", "cmd"]);
  } else {
    assert.deepEqual(shellEnum, ["bash", "sh"]);
  }
});

test("shell tool executes a simple command with the default host shell", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "autodev-shelltool-"));
  const tool = createShellTool({
    workspaceDir
  });

  const result =
    process.platform === "win32"
      ? await tool.execute({ command: "echo hello-from-shelltool", shell: "cmd" })
      : await tool.execute({ command: "printf hello-from-shelltool", shell: "sh" });

  assert.equal(result.success, true);
  assert.equal(result.content.includes("hello-from-shelltool"), true);
});
