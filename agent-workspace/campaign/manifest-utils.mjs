import path from "node:path";
import { readJsonFile } from "../src/utils/file-utils.mjs";
import { AgentWorkspaceError } from "../src/errors.mjs";

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function asInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizeScenario(raw, index) {
  const id = asString(raw?.id);
  const kind = asString(raw?.kind).toLowerCase();
  const domain = asString(raw?.domain);
  const title = asString(raw?.title);
  const goal = asString(raw?.goal);
  return {
    index,
    id,
    kind,
    domain,
    title,
    goal,
    run_workflow: asBoolean(raw?.run_workflow, kind === "workflow"),
    workflow_min_steps: asInteger(raw?.workflow_min_steps, kind === "workflow" ? 3 : 0),
    simulated_issue: asString(raw?.simulated_issue)
  };
}

export function validateManifest(manifest, options = {}) {
  const enforceStandardMix = options.enforceStandardMix !== false;
  const errors = [];

  const campaignId = asString(manifest?.campaign_id);
  const name = asString(manifest?.name);
  const version = asString(manifest?.manifest_version);
  const rawScenarios = Array.isArray(manifest?.scenarios) ? manifest.scenarios : [];
  const scenarios = rawScenarios.map((item, index) => normalizeScenario(item, index + 1));

  if (!campaignId) {
    errors.push("campaign_id is required");
  }
  if (!name) {
    errors.push("name is required");
  }
  if (!version) {
    errors.push("manifest_version is required");
  }
  if (scenarios.length === 0) {
    errors.push("scenarios requires at least one entry");
  }

  const seenIds = new Set();
  let projectCount = 0;
  let workflowCount = 0;
  for (const scenario of scenarios) {
    if (!scenario.id) {
      errors.push(`scenario at index ${scenario.index} missing id`);
    } else if (seenIds.has(scenario.id)) {
      errors.push(`scenario id duplicated: ${scenario.id}`);
    } else {
      seenIds.add(scenario.id);
    }

    if (scenario.kind !== "project" && scenario.kind !== "workflow") {
      errors.push(`scenario '${scenario.id || scenario.index}' kind must be project|workflow`);
      continue;
    }
    if (!scenario.domain) {
      errors.push(`scenario '${scenario.id || scenario.index}' domain is required`);
    }
    if (!scenario.title) {
      errors.push(`scenario '${scenario.id || scenario.index}' title is required`);
    }
    if (!scenario.goal) {
      errors.push(`scenario '${scenario.id || scenario.index}' goal is required`);
    }

    if (scenario.kind === "project") {
      projectCount += 1;
    } else {
      workflowCount += 1;
      if (scenario.workflow_min_steps < 3) {
        errors.push(`workflow scenario '${scenario.id}' requires workflow_min_steps >= 3`);
      }
      if (!scenario.run_workflow) {
        errors.push(`workflow scenario '${scenario.id}' must set run_workflow=true`);
      }
    }
  }

  if (enforceStandardMix) {
    if (scenarios.length !== 12) {
      errors.push(`standard campaign requires 12 scenarios, received ${scenarios.length}`);
    }
    if (projectCount !== 2) {
      errors.push(`standard campaign requires 2 project scenarios, received ${projectCount}`);
    }
    if (workflowCount !== 10) {
      errors.push(`standard campaign requires 10 workflow scenarios, received ${workflowCount}`);
    }
  }

  if (errors.length > 0) {
    throw new AgentWorkspaceError("campaign manifest validation failed", "CAMPAIGN_MANIFEST_INVALID", { errors });
  }

  return {
    campaign_id: campaignId,
    name,
    manifest_version: version,
    scenarios,
    mix: {
      total: scenarios.length,
      project: projectCount,
      workflow: workflowCount
    }
  };
}

export async function loadCampaignManifest(manifestPathRaw, options = {}) {
  const manifestPath = path.resolve(manifestPathRaw);
  const manifest = await readJsonFile(manifestPath);
  const normalized = validateManifest(manifest, options);
  return {
    manifestPath,
    manifest: normalized
  };
}
