import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../../server/src/app.ts";
import { startTestHttpServer } from "../../server/src/__tests__/helpers/http-test-server.ts";
import { runApply } from "../src/engine.mjs";
import { buildBundle, createContextFromBundle, createSkillSource, createTempBundle } from "./helpers.mjs";

test("apply rollback removes created resources when a later module fails", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-rollback-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });

  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);
  const previousFailureModule = process.env.AGENT_WORKSPACE_FAIL_MODULE;
  process.env.AGENT_WORKSPACE_FAIL_MODULE = "skill.workflow-template.create";

  try {
    const seed = { bundleId: "bundle_rollback_fail", prefix: "tg_rollback", workspacePath: workspaceRoot };
    const bundle = buildBundle(seed);
    const { bundleDir, bundlePath } = await createTempBundle(bundle);
    await createSkillSource(bundleDir, "skills/skill_a", "tg_rollback-skill-a");

    const context = await createContextFromBundle(server.baseUrl, bundlePath, false);
    const result = await runApply(context);
    assert.equal(result.status, "fail");
    assert.equal(result.rollback.length > 0, true);

    const [skillsRes, listsRes, agentsRes, projectsRes, templatesRes, runsRes] = await Promise.all([
      fetch(`${server.baseUrl}/api/skills`),
      fetch(`${server.baseUrl}/api/skill-lists`),
      fetch(`${server.baseUrl}/api/agents`),
      fetch(`${server.baseUrl}/api/projects`),
      fetch(`${server.baseUrl}/api/workflow-templates`),
      fetch(`${server.baseUrl}/api/workflow-runs`)
    ]);
    const skills = await skillsRes.json();
    const lists = await listsRes.json();
    const agents = await agentsRes.json();
    const projects = await projectsRes.json();
    const templates = await templatesRes.json();
    const runs = await runsRes.json();

    assert.equal(
      (skills.items ?? []).some((item) => item.skillId === "tg_rollback-skill-a"),
      false
    );
    assert.equal(
      (lists.items ?? []).some((item) => item.listId === "tg_rollback_skill_list"),
      false
    );
    assert.equal(
      (agents.items ?? []).some((item) => item.agentId === "tg_rollback_mgr"),
      false
    );
    assert.equal(
      (agents.items ?? []).some((item) => item.agentId === "tg_rollback_qa_guard"),
      false
    );
    assert.equal(
      (projects.items ?? []).some((item) => item.projectId === "tg_rollback_project"),
      false
    );
    assert.equal(
      (templates.items ?? []).some((item) => item.templateId === "tg_rollback_wf_tpl"),
      false
    );
    assert.equal(
      (runs.items ?? []).some((item) => item.runId === "tg_rollback_wf_run"),
      false
    );
  } finally {
    if (previousFailureModule === undefined) {
      delete process.env.AGENT_WORKSPACE_FAIL_MODULE;
    } else {
      process.env.AGENT_WORKSPACE_FAIL_MODULE = previousFailureModule;
    }
    await server.close();
  }
});

