import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../../server/src/app.ts";
import { startTestHttpServer } from "../../server/src/__tests__/helpers/http-test-server.ts";
import { runApply } from "../src/engine.mjs";
import { createContextFromBundle, createSkillSource, createTempBundle, buildBundle } from "./helpers.mjs";

test("dry-run + apply imports full chain and workflow run remains created", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-apply-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });

  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);
  try {
    const seed = { bundleId: "bundle_apply_ok", prefix: "tg_apply", workspacePath: workspaceRoot };
    const bundle = buildBundle(seed);
    const { bundleDir, bundlePath } = await createTempBundle(bundle);
    await createSkillSource(bundleDir, "skills/skill_a", "tg_apply-skill-a");

    const dryRunContext = await createContextFromBundle(server.baseUrl, bundlePath, true);
    const dryRunResult = await runApply(dryRunContext);
    assert.equal(dryRunResult.status, "pass");
    assert.equal(dryRunResult.dry_run, true);

    const applyContext = await createContextFromBundle(server.baseUrl, bundlePath, false);
    const applyResult = await runApply(applyContext);
    assert.equal(applyResult.status, "pass");
    assert.equal(applyResult.created_resources.project_id, "tg_apply_project");
    assert.equal(applyResult.created_resources.workflow_template_id, "tg_apply_wf_tpl");
    assert.equal(applyResult.created_resources.workflow_run_id, "tg_apply_wf_run");

    const runsRes = await fetch(`${server.baseUrl}/api/workflow-runs`);
    assert.equal(runsRes.status, 200);
    const runsPayload = await runsRes.json();
    const run = (runsPayload.items ?? []).find((item) => item.runId === "tg_apply_wf_run");
    assert.ok(run);
    assert.equal(run.status, "created");

    const agentsRes = await fetch(`${server.baseUrl}/api/agents`);
    const agentsPayload = await agentsRes.json();
    assert.equal(
      (agentsPayload.items ?? []).some((item) => item.agentId === "tg_apply_mgr"),
      true
    );
    assert.equal(
      (agentsPayload.items ?? []).some((item) => item.agentId === "tg_apply_dev"),
      true
    );
    assert.equal(
      (agentsPayload.items ?? []).some((item) => item.agentId === "tg_apply_qa_guard"),
      true
    );
  } finally {
    await server.close();
  }
});

