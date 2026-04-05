import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";

function runNode(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn("node", args, { cwd, shell: false, windowsHide: true });
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

test("campaign cli rejects removed real mode", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-campaign-cli-"));
  const manifestPath = path.join(tempRoot, "manifest.json");
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        manifest_version: "1.0",
        campaign_id: "cli_mode_test",
        name: "cli mode test",
        scenarios: [
          {
            id: "wf_a",
            kind: "workflow",
            domain: "business_analysis",
            title: "wf_a",
            goal: "goal",
            workflow_min_steps: 3,
            run_workflow: true
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = await runNode(repoRoot, [
    "agent-workspace/campaign/run-campaign.mjs",
    "--manifest",
    manifestPath,
    "--base-url",
    "http://127.0.0.1:43123",
    "--dry-run",
    "--allow-custom-mix",
    "--agent-mode",
    "real"
  ]);

  assert.equal(result.code !== 0, true);
  assert.equal(
    result.stderr.includes("real mode was removed") || result.stderr.includes("CAMPAIGN_REAL_MODE_REMOVED"),
    true
  );
});
