import assert from "node:assert/strict";
import { test } from "node:test";
import { validateManifest } from "../campaign/manifest-utils.mjs";
import { AgentWorkspaceError } from "../src/errors.mjs";

function buildManifest() {
  const scenarios = [];
  scenarios.push({
    id: "p1",
    kind: "project",
    domain: "business",
    title: "project-1",
    goal: "goal-1",
    run_workflow: false
  });
  scenarios.push({
    id: "p2",
    kind: "project",
    domain: "hr",
    title: "project-2",
    goal: "goal-2",
    run_workflow: false
  });
  for (let i = 0; i < 10; i += 1) {
    scenarios.push({
      id: `w${i + 1}`,
      kind: "workflow",
      domain: "ops",
      title: `workflow-${i + 1}`,
      goal: "workflow-goal",
      workflow_min_steps: 3,
      run_workflow: true
    });
  }
  return {
    manifest_version: "1.0",
    campaign_id: "cmp_test",
    name: "campaign test",
    scenarios
  };
}

test("campaign manifest validation passes for standard 2P+10W mix", () => {
  const normalized = validateManifest(buildManifest());
  assert.equal(normalized.mix.total, 12);
  assert.equal(normalized.mix.project, 2);
  assert.equal(normalized.mix.workflow, 10);
});

test("campaign manifest validation passes for workflow-only custom mix when standard mix is disabled", () => {
  const manifest = buildManifest();
  manifest.scenarios = manifest.scenarios.slice(2);
  const normalized = validateManifest(manifest, { enforceStandardMix: false });
  assert.equal(normalized.mix.total, 10);
  assert.equal(normalized.mix.project, 0);
  assert.equal(normalized.mix.workflow, 10);
});

test("campaign manifest rejects workflow with less than 3 steps", () => {
  const manifest = buildManifest();
  manifest.scenarios[2].workflow_min_steps = 2;
  let caught = null;
  try {
    validateManifest(manifest);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AgentWorkspaceError);
  assert.equal(caught.code, "CAMPAIGN_MANIFEST_INVALID");
  assert.equal(
    (caught.details?.errors ?? []).some((item) => String(item).includes("workflow_min_steps >= 3")),
    true
  );
});
