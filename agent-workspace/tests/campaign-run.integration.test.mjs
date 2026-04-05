import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../../server/src/app.ts";
import { startTestHttpServer } from "../../server/src/__tests__/helpers/http-test-server.ts";
import { runCampaign } from "../campaign/run-campaign.mjs";
import { buildBundle, createSkillSource } from "./helpers.mjs";

test("campaign runner executes rounds serially and continues after failed round", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-campaign-int-"));
  const dataRoot = path.join(tempRoot, "data");
  const outputRoot = path.join(tempRoot, "reports");
  const manifestPath = path.join(tempRoot, "manifest.json");
  const constraintPackPath = path.join(tempRoot, "constraint-pack.md");

  const manifest = {
    manifest_version: "1.0",
    campaign_id: "cmp_int",
    name: "integration campaign",
    scenarios: [
      {
        id: "wf_pass_1",
        kind: "workflow",
        domain: "business_analysis",
        title: "workflow pass 1",
        goal: "goal 1",
        workflow_min_steps: 3,
        run_workflow: true
      },
      {
        id: "wf_fail_missing_qa",
        kind: "workflow",
        domain: "business_analysis",
        title: "workflow fail",
        goal: "goal 2",
        workflow_min_steps: 3,
        run_workflow: true,
        simulated_issue: "missing_qa"
      },
      {
        id: "wf_pass_2",
        kind: "workflow",
        domain: "finance",
        title: "workflow pass 2",
        goal: "goal 3",
        workflow_min_steps: 3,
        run_workflow: true
      }
    ]
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.writeFile(constraintPackPath, "# base\n- keep qa guard\n", "utf8");

  const bundleGenerator = async ({ scenario, roundIndex, workspaceRoot, runPrefix }) => {
    const scenarioPrefix = `${runPrefix}_${String(roundIndex).padStart(2, "0")}_${scenario.id}`;
    const skillName = `${scenarioPrefix}-skill-a`;
    await createSkillSource(workspaceRoot, path.join("skills", scenario.id), skillName);
    const bundle = buildBundle({
      prefix: scenarioPrefix,
      bundleId: `${scenarioPrefix}_bundle`,
      workspacePath: path.join(workspaceRoot, "workspace")
    });
    bundle.skills_sources = [`../skills/${scenario.id}`];
    bundle.skill_lists[0].skill_ids = [skillName];
    if (scenario.simulated_issue === "missing_qa") {
      bundle.agents = bundle.agents.filter((item) => !item.agent_id.endsWith("_qa_guard"));
    }
    const bundlePath = path.join(workspaceRoot, "bundles", `${scenario.id}.bundle.json`);
    await fs.writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    return {
      bundlePath,
      bundle,
      mode: "test_bundle_generator"
    };
  };

  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);
  try {
    const report = await runCampaign({
      baseUrl: server.baseUrl,
      manifestPath,
      outputRoot,
      constraintPackPath,
      dryRun: true,
      enforceStandardMix: false,
      maxPollSeconds: 2,
      runPrefix: "int",
      bundleGenerator
    });

    assert.equal(report.rounds.length, 3);
    assert.equal(report.rounds[0].status, "pass");
    assert.equal(report.rounds[1].status, "fail");
    assert.equal(report.rounds[1].failure_category, "template_design");
    assert.equal(report.rounds[2].status, "pass");
    assert.equal(report.summary.total_rounds, 3);
    assert.equal(report.summary.fail_rounds, 1);

    const reportPath = path.join(report.output_dir, "campaign_report.json");
    const stat = await fs.stat(reportPath);
    assert.equal(stat.isFile(), true);
  } finally {
    await server.close();
  }
});
