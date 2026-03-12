import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

test("project and workflow TEAM.md consume agent summary with existing links", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-team-summary-"));
  const dataRoot = path.join(tempRoot, "data");
  const projectWorkspace = path.join(tempRoot, "project-workspace");
  const workflowWorkspace = path.join(tempRoot, "workflow-workspace");
  await fs.mkdir(projectWorkspace, { recursive: true });
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
    const createAgent = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "pm_product",
        display_name: "PM Product",
        prompt: "Own requirements.",
        summary: "Owns requirement decomposition and planning decisions."
      })
    });
    assert.equal(createAgent.status, 201);

    const createProject = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "team-summary-project",
        name: "Team Summary Project",
        workspace_path: projectWorkspace,
        agent_ids: ["pm_product"]
      })
    });
    assert.equal(createProject.status, 201);

    const projectTeamMd = await fs.readFile(path.join(projectWorkspace, "Agents", "TEAM.md"), "utf8");
    assert.equal(
      projectTeamMd.includes("- [pm_product](./pm_product/) - Owns requirement decomposition and planning decisions."),
      true
    );

    const createTemplate = await fetch(`${baseUrl}/api/workflow-templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "team_summary_tpl",
        name: "Team Summary Template",
        tasks: [{ task_id: "wf_task_1", title: "Plan", owner_role: "pm_product" }]
      })
    });
    assert.equal(createTemplate.status, 201);

    const createRun = await fetch(`${baseUrl}/api/workflow-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "team_summary_tpl",
        run_id: "team_summary_run",
        workspace_path: workflowWorkspace
      })
    });
    assert.equal(createRun.status, 201);

    const workflowTeamMd = await fs.readFile(path.join(workflowWorkspace, "Agents", "TEAM.md"), "utf8");
    assert.equal(
      workflowTeamMd.includes("- [pm_product](./pm_product/) - Owns requirement decomposition and planning decisions."),
      true
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
