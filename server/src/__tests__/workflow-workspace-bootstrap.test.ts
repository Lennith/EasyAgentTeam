import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

test("workflow run bootstrap creates agent workspace files with fallback prompt for unregistered role", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-workspace-bootstrap-"));
  const dataRoot = path.join(tempRoot, "data");
  const workflowWorkspace = path.join(tempRoot, "workflow-workspace");
  await fs.mkdir(workflowWorkspace, { recursive: true });

  const app = createApp({ dataRoot });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start test server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createTemplate = await fetch(`${baseUrl}/api/workflow-templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "wf_bootstrap_tpl",
        name: "Workflow Bootstrap Template",
        tasks: [{ task_id: "wf_task_1", title: "Implement", owner_role: "custom_dev_role" }]
      })
    });
    assert.equal(createTemplate.status, 201);

    const createRun = await fetch(`${baseUrl}/api/workflow-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "wf_bootstrap_tpl",
        run_id: "wf_bootstrap_run",
        workspace_path: workflowWorkspace
      })
    });
    assert.equal(createRun.status, 201);

    const roleDir = path.join(workflowWorkspace, "Agents", "custom_dev_role");
    const rootAgentsMd = await fs.readFile(path.join(workflowWorkspace, "AGENTS.md"), "utf8");
    const agentsMd = await fs.readFile(path.join(roleDir, "AGENTS.md"), "utf8");
    const roleMd = await fs.readFile(path.join(roleDir, "role.md"), "utf8");
    const progressMd = await fs.readFile(path.join(roleDir, "progress.md"), "utf8");

    assert.equal(rootAgentsMd.includes("# TeamWorkSpace AGENTS Guide"), true);
    assert.equal(rootAgentsMd.includes("./Agents/custom_dev_role/AGENTS.md"), true);
    assert.equal(agentsMd.includes("# AGENTS Runtime Guide"), true);
    assert.equal(roleMd.includes("Role: custom_dev_role"), true);
    assert.equal(progressMd.includes("# Progress - custom_dev_role"), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
