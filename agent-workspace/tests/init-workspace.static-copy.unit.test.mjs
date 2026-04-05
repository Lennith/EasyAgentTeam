import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { initAgentWorkspace } from "../src/init-workspace.mjs";

test("initAgentWorkspace copies static TemplateAgentWorkspace and patches base_url", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-init-static-"));
  const workspaceRoot = path.join(tempRoot, "external-agent-workspace");
  const baseUrl = "http://127.0.0.1:43123";

  const result = await initAgentWorkspace({
    goal: "build a static workspace test",
    baseUrl,
    workspaceRoot
  });

  assert.equal(result.status, "pass");
  assert.equal(path.resolve(result.workspaceRoot), path.resolve(workspaceRoot));

  const agentsGuide = await fs.readFile(path.join(workspaceRoot, "AGENTS.md"), "utf8");
  assert.equal(agentsGuide.includes("TemplateAgent Working Contract"), true);
  assert.equal(agentsGuide.includes("template_bundle_guard"), true);

  const config = JSON.parse(await fs.readFile(path.join(workspaceRoot, ".agent-tools", "config.json"), "utf8"));
  assert.equal(config.base_url, baseUrl);

  await fs.access(path.join(workspaceRoot, "reports", "step-01-goal.md"));
  await fs.access(path.join(workspaceRoot, "reports", "step-06-submit.json"));

  const initReport = JSON.parse(await fs.readFile(result.reportJsonPath, "utf8"));
  assert.equal(typeof initReport.template_source === "string", true);
  assert.equal(initReport.template_source.endsWith("TemplateAgentWorkspace"), true);
});
