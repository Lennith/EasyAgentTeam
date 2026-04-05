import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

function runNode(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ code: Number(code ?? 0), stdout, stderr });
    });
  });
}

test("template-agent cleanup script supports dry-run mode", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const result = await runNode(repoRoot, ["E2ETest/scripts/cleanup-template-agent-test-data.mjs"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.includes("[cleanup] dry_run=true"), true);
  assert.equal(result.stdout.includes("cleanup_report.json"), true);
});
