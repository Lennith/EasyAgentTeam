import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

const fetch = globalThis.fetch;

test("repo_doc_flow template scaffolds role documentation files", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-project-template-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(path.join(workspacePath, "devtools"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, "DevTools"), { recursive: true });
  await fs.writeFile(path.join(workspacePath, "autodev_handoff.ps1"), "legacy", "utf8");
  await fs.writeFile(path.join(workspacePath, "autodev_clarify.ps1"), "legacy", "utf8");
  await fs.writeFile(path.join(workspacePath, "autodev_route_targets.ps1"), "legacy", "utf8");
  await fs.writeFile(path.join(workspacePath, "autodev_lock.ps1"), "legacy", "utf8");

  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "templatedoc",
        name: "Template Doc",
        workspace_path: workspacePath,
        template_id: "repo_doc_flow"
      })
    });
    assert.equal(createRes.status, 201);

    const expectedFiles = [
      "docs/README.md",
      "docs/requirements/product_requirements.md",
      "docs/planning/development_plan.md",
      "docs/planning/api_interface_design.md",
      "docs/tasks/devleader_task_breakdown.md",
      "docs/status/dev_progress_updates.md",
      "docs/process/locking_and_reporting.md"
    ];

    for (const relativePath of expectedFiles) {
      const absolutePath = path.join(workspacePath, ...relativePath.split("/"));
      const content = await fs.readFile(absolutePath, "utf8");
      assert.equal(content.startsWith("\uFEFF"), true);
    }

    await assert.rejects(async () => fs.access(path.join(workspacePath, "devtools")));
    await assert.rejects(async () => fs.access(path.join(workspacePath, "DevTools")));
    await assert.rejects(async () => fs.access(path.join(workspacePath, "autodev_handoff.ps1")));
    await assert.rejects(async () => fs.access(path.join(workspacePath, "autodev_clarify.ps1")));
    await assert.rejects(async () => fs.access(path.join(workspacePath, "autodev_route_targets.ps1")));
    await assert.rejects(async () => fs.access(path.join(workspacePath, "autodev_lock.ps1")));

    const eventsRes = await fetch(`${baseUrl}/api/projects/templatedoc/events`);
    assert.equal(eventsRes.status, 200);
    const lines = (await eventsRes.text())
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { eventType: string });
    const types = new Set(lines.map((line) => line.eventType));
    assert.equal(types.has("PROJECT_TEMPLATE_APPLIED"), true);
    assert.equal(types.has("PROJECT_AGENT_SCRIPT_BOOTSTRAPPED"), true);
  } finally {
    await serverHandle.close();
  }
});

test("project bootstrap creates per-agent AGENTS.md with direct ToolCall guidance", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-agent-workspace-bootstrap-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });

  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const createAgentRes = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "pm_product",
        display_name: "PM Product",
        prompt: "You own product requirements."
      })
    });
    assert.equal(createAgentRes.status, 201);

    const createProjectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "agentworkspace",
        name: "Agent Workspace",
        workspace_path: workspacePath,
        agent_ids: ["pm_product"]
      })
    });
    assert.equal(createProjectRes.status, 201);

    const agentWorkspaceAgentsPath = path.join(workspacePath, "Agents", "pm_product", "AGENTS.md");
    const agentWorkspaceAgentsContent = await fs.readFile(agentWorkspaceAgentsPath, "utf8");
    const rootAgentsContent = await fs.readFile(path.join(workspacePath, "AGENTS.md"), "utf8");
    assert.equal(agentWorkspaceAgentsContent.includes("../../TeamTools/TeamToolsList.md"), false);
    assert.equal(agentWorkspaceAgentsContent.includes("Read `../TEAM.md`"), true);
    assert.equal(agentWorkspaceAgentsContent.includes("task_create_assign"), true);
    assert.equal(agentWorkspaceAgentsContent.includes("task_report_in_progress"), true);
    assert.equal(agentWorkspaceAgentsContent.includes("Do not use Get-Command"), true);
    assert.equal(agentWorkspaceAgentsContent.includes("Shell output is never evidence"), true);
    assert.equal(agentWorkspaceAgentsContent.includes("corresponding ToolCall is invalid"), true);
    assert.equal(agentWorkspaceAgentsContent.includes("Error Handling"), true);
    assert.equal(agentWorkspaceAgentsContent.includes("You are running as role"), false);
    assert.equal(rootAgentsContent.includes("# TeamWorkSpace AGENTS Guide"), true);
    assert.equal(rootAgentsContent.includes("./Agents/pm_product/AGENTS.md"), true);

    const roleMdPath = path.join(workspacePath, "Agents", "pm_product", "role.md");
    const roleMdContent = await fs.readFile(roleMdPath, "utf8");
    assert.equal(roleMdContent.includes("You own product requirements."), true);
    assert.equal(roleMdContent.includes("../../TeamTools/TeamToolsList.md"), false);
    assert.equal(roleMdContent.includes("Tool schemas are exposed directly by runtime tool registry."), true);
    assert.equal(roleMdContent.includes("TeamTool entries are model-callable tools."), true);
  } finally {
    await serverHandle.close();
  }
});

test("base prompt API returns TeamTools initialization contract", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-base-prompt-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const res = await fetch(`${baseUrl}/api/prompts/base`);
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { version: string; prompt: string };
    assert.equal(typeof payload.version, "string");
    assert.equal(payload.prompt.includes("AGENTS.md"), true);
    assert.equal(payload.prompt.includes("discuss"), true);
  } finally {
    await serverHandle.close();
  }
});

test("delete project removes project data and returns not found afterwards", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-project-delete-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "deletecase",
        name: "Delete Case",
        workspace_path: tempRoot
      })
    });
    assert.equal(createRes.status, 201);

    const projectRoot = path.join(dataRoot, "projects", "deletecase");
    await fs.access(projectRoot);

    const deleteRes = await fetch(`${baseUrl}/api/projects/deletecase`, {
      method: "DELETE"
    });
    assert.equal(deleteRes.status, 200);

    await assert.rejects(async () => fs.access(projectRoot));

    const readRes = await fetch(`${baseUrl}/api/projects/deletecase`);
    assert.equal(readRes.status, 404);
  } finally {
    await serverHandle.close();
  }
});

test("role template injects boundary/report rules for eng_manager and qa roles", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-agent-role-fallback-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });

  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const createEngManagerRes = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "eng_manager",
        display_name: "Engineering Manager",
        prompt: "Coordinate engineering."
      })
    });
    assert.equal(createEngManagerRes.status, 201);

    const createQaRes = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "qa_guard",
        display_name: "QA Guard",
        prompt: "Validate quality."
      })
    });
    assert.equal(createQaRes.status, 201);

    const createProjectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "rolefallback",
        name: "Role Fallback",
        workspace_path: workspacePath,
        agent_ids: ["eng_manager", "qa_guard"]
      })
    });
    assert.equal(createProjectRes.status, 201);

    const engManagerRolePath = path.join(workspacePath, "Agents", "eng_manager", "role.md");
    const engManagerRoleMd = await fs.readFile(engManagerRolePath, "utf8");
    assert.equal(engManagerRoleMd.includes("Coordinate engineering."), true);
    assert.equal(engManagerRoleMd.includes("## Role Boundary"), true);

    const qaRolePath = path.join(workspacePath, "Agents", "qa_guard", "role.md");
    const qaRoleMd = await fs.readFile(qaRolePath, "utf8");
    assert.equal(qaRoleMd.includes("Validate quality."), true);
    assert.equal(qaRoleMd.includes("## Role Boundary"), true);
  } finally {
    await serverHandle.close();
  }
});

test("project creation persists auto_dispatch_enabled and auto_dispatch_remaining in project config", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-project-auto-dispatch-limit-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "autodispatchlimit",
        name: "Auto Dispatch Limit Case",
        workspace_path: tempRoot,
        auto_dispatch_enabled: true,
        auto_dispatch_remaining: 5
      })
    });
    assert.equal(createRes.status, 201);

    const projectRes = await fetch(`${baseUrl}/api/projects/autodispatchlimit`);
    assert.equal(projectRes.status, 200);
    const project = (await projectRes.json()) as {
      autoDispatchEnabled?: boolean;
      autoDispatchRemaining?: number;
      holdEnabled?: boolean;
    };
    assert.equal(project.autoDispatchEnabled, true);
    assert.equal(project.autoDispatchRemaining, 5);
    assert.equal(project.holdEnabled, false);
  } finally {
    await serverHandle.close();
  }
});

test(
  "project bootstrap ignores missing TeamTools template source in direct ToolCall mode",
  { concurrency: false },
  async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-teamtools-missing-"));
    const dataRoot = path.join(tempRoot, "data");
    const app = createApp({ dataRoot });
    const serverHandle = await startTestHttpServer(app);
    const baseUrl = serverHandle.baseUrl;
    const prev = process.env.AUTO_DEV_TEAMTOOLS_SOURCE;
    process.env.AUTO_DEV_TEAMTOOLS_SOURCE = path.join(tempRoot, "not-found-teamtools");

    try {
      const createRes = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: "teamtoolsmissing",
          name: "TeamTools Missing",
          workspace_path: tempRoot
        })
      });
      assert.equal(createRes.status, 201);
    } finally {
      if (prev === undefined) {
        delete process.env.AUTO_DEV_TEAMTOOLS_SOURCE;
      } else {
        process.env.AUTO_DEV_TEAMTOOLS_SOURCE = prev;
      }
      await serverHandle.close();
    }
  }
);

test("project bootstrap applies workspace role template override", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-role-template-override-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  await fs.mkdir(path.join(workspacePath, "TeamTools", "templates", "agent-workspace"), { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, "TeamTools", "templates", "agent-workspace", "agent.role.md"),
    [
      "# Custom Role Template {{ROLE}}",
      "",
      "{{PROMPT_INTEGRITY}}",
      "",
      "## Boundary",
      "{{ROLE_BOUNDARY}}",
      "",
      "## Prompt",
      "{{ROLE_PROMPT}}"
    ].join("\n"),
    "utf8"
  );

  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const createAgentRes = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "pm_product",
        display_name: "PM Product",
        prompt: "Prompt from agent registry"
      })
    });
    assert.equal(createAgentRes.status, 201);

    const createProjectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "roletemplateoverride",
        name: "Role Template Override",
        workspace_path: workspacePath,
        agent_ids: ["pm_product"]
      })
    });
    assert.equal(createProjectRes.status, 201);

    const rolePath = path.join(workspacePath, "Agents", "pm_product", "role.md");
    const roleMd = await fs.readFile(rolePath, "utf8");
    assert.equal(roleMd.includes("# Custom Role Template pm_product"), true);
    assert.equal(roleMd.includes("Prompt from agent registry"), true);
    assert.equal(roleMd.includes("## Boundary"), true);
  } finally {
    await serverHandle.close();
  }
});

test("patching agent prompt does not auto-sync existing project role.md", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-agent-prompt-sync-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspacePath = path.join(tempRoot, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });

  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const createAgentRes = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "pm_product",
        display_name: "PM Product",
        prompt: "Old prompt body"
      })
    });
    assert.equal(createAgentRes.status, 201);

    const createProjectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "agentpromptsync",
        name: "Agent Prompt Sync",
        workspace_path: workspacePath,
        agent_ids: ["pm_product"]
      })
    });
    assert.equal(createProjectRes.status, 201);

    const rolePath = path.join(workspacePath, "Agents", "pm_product", "role.md");
    const before = await fs.readFile(rolePath, "utf8");
    assert.equal(before.includes("Old prompt body"), true);

    const patchRes = await fetch(`${baseUrl}/api/agents/pm_product`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "New prompt body from agent control"
      })
    });
    assert.equal(patchRes.status, 200);
    const patchPayload = (await patchRes.json()) as { prompt: string; syncedProjects?: string[] };
    assert.equal(patchPayload.prompt.includes("New prompt body from agent control"), true);
    assert.equal("syncedProjects" in patchPayload, false);

    const after = await fs.readFile(rolePath, "utf8");
    assert.equal(after.includes("Old prompt body"), true);
    assert.equal(after.includes("New prompt body from agent control"), false);
  } finally {
    await serverHandle.close();
  }
});
