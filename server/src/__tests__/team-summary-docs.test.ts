import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

test("project and workflow TEAM.md consume agent summary with existing links", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-team-summary-"));
  const dataRoot = path.join(tempRoot, "data");
  const projectWorkspace = path.join(tempRoot, "project-workspace");
  const workflowWorkspace = path.join(tempRoot, "workflow-workspace");
  await fs.mkdir(projectWorkspace, { recursive: true });
  await fs.mkdir(workflowWorkspace, { recursive: true });

  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

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
    const workflowRoleMd = await fs.readFile(path.join(workflowWorkspace, "Agents", "pm_product", "role.md"), "utf8");
    assert.equal(workflowRoleMd.includes("Role: pm_product"), true);
    const workflowProgressMd = await fs.readFile(
      path.join(workflowWorkspace, "Agents", "pm_product", "progress.md"),
      "utf8"
    );
    assert.equal(workflowProgressMd.includes("# Progress - pm_product"), true);
  } finally {
    await serverHandle.close();
  }
});
