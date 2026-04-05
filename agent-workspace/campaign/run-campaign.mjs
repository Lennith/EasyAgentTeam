#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTemplateBundle } from "../src/bundle-loader.mjs";
import { createRuntimeContext } from "../src/context.mjs";
import { runApply, runValidate } from "../src/engine.mjs";
import { AgentWorkspaceError } from "../src/errors.mjs";
import { initAgentWorkspace } from "../src/init-workspace.mjs";
import { ensureDir, writeJsonFile, writeTextFile } from "../src/utils/file-utils.mjs";
import { categorizeFailure, deriveConstraintUpdates, observeWorkflowRun } from "./observe-run.mjs";
import { loadCampaignManifest } from "./manifest-utils.mjs";
import { simulateExternalSubagentBundle } from "./simulated-agent.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const defaultManifestPath = path.resolve(__dirname, "scenarios.manifest.json");
const defaultConstraintPackPath = path.resolve(__dirname, "constraint-pack.md");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function ensureArg(value, name) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new AgentWorkspaceError(`missing required argument: --${name}`, "CAMPAIGN_CLI_INPUT_INVALID");
  }
  return normalized;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function topFailureCategories(rounds) {
  const counts = new Map();
  for (const item of rounds) {
    if (item.status === "pass") {
      continue;
    }
    const key = String(item.failure_category || "unknown");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count }));
}

function toRoundMarkdown(round) {
  const lines = [];
  lines.push(`# Round ${round.round} - ${round.scenario.id}`);
  lines.push("");
  lines.push(`- title: ${round.scenario.title}`);
  lines.push(`- kind: ${round.scenario.kind}`);
  lines.push(`- domain: ${round.scenario.domain}`);
  lines.push(`- agent_mode: ${round.agent_mode || "n/a"}`);
  lines.push(`- status: ${round.status}`);
  lines.push(`- failure_category: ${round.failure_category || "n/a"}`);
  lines.push(`- backend_suspect: ${round.backend_suspect}`);
  lines.push(`- bundle_path: ${round.bundle_path || "n/a"}`);
  lines.push("");
  lines.push("## Steps");
  lines.push(`- init: ${round.steps.init}`);
  lines.push(`- generate_bundle: ${round.steps.generate_bundle}`);
  lines.push(`- validate: ${round.steps.validate}`);
  lines.push(`- apply: ${round.steps.apply}`);
  lines.push(`- run_observe: ${round.steps.run_observe}`);
  lines.push("");
  if (round.runtime) {
    lines.push("## Runtime");
    lines.push(`- progressed: ${round.runtime.progressed}`);
    lines.push(`- blocker_count: ${round.runtime.blocker_count}`);
    lines.push(`- run_status: ${round.runtime.run_status}`);
    lines.push("");
  }
  if (round.constraint_updates?.length > 0) {
    lines.push("## Constraint Updates");
    for (const item of round.constraint_updates) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }
  if (round.error) {
    lines.push("## Error");
    lines.push(`- code: ${round.error.code || "n/a"}`);
    lines.push(`- message: ${round.error.message || "n/a"}`);
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function toCampaignMarkdown(report) {
  const lines = [];
  lines.push("# Agent Workspace Campaign Report");
  lines.push("");
  lines.push(`- campaign_id: ${report.campaign_id}`);
  lines.push(`- name: ${report.name}`);
  lines.push(`- run_id: ${report.run_id}`);
  lines.push(`- started_at: ${report.started_at}`);
  lines.push(`- ended_at: ${report.ended_at}`);
  lines.push(`- dry_run: ${report.dry_run}`);
  lines.push(`- total_rounds: ${report.summary.total_rounds}`);
  lines.push(`- pass_rounds: ${report.summary.pass_rounds}`);
  lines.push(`- fail_rounds: ${report.summary.fail_rounds}`);
  lines.push(`- workflow_total: ${report.summary.workflow_total}`);
  lines.push(`- workflow_converged: ${report.summary.workflow_converged}`);
  lines.push(`- workflow_convergence_rate: ${report.summary.workflow_convergence_rate}`);
  lines.push("");
  lines.push("## Top Failure Categories");
  for (const item of report.summary.top_failure_categories) {
    lines.push(`- ${item.category}: ${item.count}`);
  }
  if (report.summary.top_failure_categories.length === 0) {
    lines.push("- (none)");
  }
  lines.push("");
  lines.push("## Backend Suspect Rounds");
  if (report.summary.backend_suspect_rounds.length === 0) {
    lines.push("- (none)");
  } else {
    for (const item of report.summary.backend_suspect_rounds) {
      lines.push(`- ${item}`);
    }
  }
  lines.push("");
  lines.push("## Constraint Evolution");
  if (report.constraint_evolution.length === 0) {
    lines.push("- (none)");
  } else {
    for (const item of report.constraint_evolution) {
      lines.push(`- [round ${item.round}] ${item.rule}`);
    }
  }
  lines.push("");
  return `${lines.join("\n").trim()}\n`;
}

function appendConstraintPack(baseText, evolution) {
  const lines = [baseText.trimEnd(), "", "## Incremental Updates"];
  if (evolution.length === 0) {
    lines.push("- (none)");
  } else {
    for (const item of evolution) {
      lines.push(`- [round ${item.round}] ${item.rule}`);
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

function toSafeError(error) {
  if (!error) {
    return null;
  }
  if (error instanceof AgentWorkspaceError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { code: "UNEXPECTED_ERROR", message: error.message };
  }
  return { code: "UNKNOWN_ERROR", message: String(error) };
}

function defaultRoundStatus(round) {
  if (round.steps.validate !== "pass" || round.steps.apply !== "pass") {
    return "fail";
  }
  if (
    round.scenario.kind === "workflow" &&
    round.scenario.run_workflow &&
    round.steps.run_observe !== "pass" &&
    round.steps.run_observe !== "skipped"
  ) {
    return "fail";
  }
  return "pass";
}

function derivePassConstraintUpdate(scenario) {
  return `Preserve the round-prefixed naming and keep the QA Guard acceptance step explicit for ${scenario.id}.`;
}

export async function runCampaign(options) {
  const startedAt = new Date().toISOString();
  const manifestLoaded = await loadCampaignManifest(options.manifestPath, {
    enforceStandardMix: options.enforceStandardMix
  });
  const manifest = manifestLoaded.manifest;
  const dryRun = Boolean(options.dryRun);
  const bundleGenerator = options.bundleGenerator ?? simulateExternalSubagentBundle;
  const maxPollSeconds = Number.isFinite(Number(options.maxPollSeconds))
    ? Number(options.maxPollSeconds)
    : 10;

  const constraintBase = await fs.readFile(options.constraintPackPath, "utf8");
  const runId = `${manifest.campaign_id}-${nowStamp()}`;
  const outputDir = path.resolve(options.outputRoot, runId);
  await ensureDir(outputDir);

  const rounds = [];
  const constraintEvolution = [];
  let constraintPackCurrent = constraintBase;
  const roundStart = Number.isFinite(Number(options.roundStart)) ? Number(options.roundStart) : 1;

  for (let i = 0; i < manifest.scenarios.length; i += 1) {
    const scenario = manifest.scenarios[i];
    const round = roundStart + i;
    const roundDir = path.join(outputDir, `round-${String(round).padStart(2, "0")}-${scenario.id}`);
    await ensureDir(roundDir);

    const roundRecord = {
      round,
      scenario,
      status: "fail",
      failure_category: "",
      backend_suspect: false,
      bundle_path: "",
      steps: {
        init: "pending",
        generate_bundle: "pending",
        validate: "pending",
        apply: "pending",
        run_observe: scenario.kind === "workflow" && scenario.run_workflow && !dryRun ? "pending" : "skipped"
      },
      agent_mode: "simulated_external_subagent",
      validate_report: null,
      apply_report: null,
      runtime: null,
      error: null,
      constraint_updates: []
    };

    const scenarioWorkspace = path.join(roundDir, "external-agent-workspace");
    const bundlePath = path.join(scenarioWorkspace, "bundles", `${scenario.id}.bundle.json`);
    try {
      const initResult = await initAgentWorkspace({
        goal: scenario.goal,
        baseUrl: options.baseUrl,
        workspaceRoot: scenarioWorkspace
      });
      roundRecord.steps.init = initResult.status;

      const generated = await bundleGenerator({
        scenario,
        roundIndex: round,
        workspaceRoot: scenarioWorkspace,
        bundlePath,
        runPrefix: options.runPrefix,
        constraintPack: constraintPackCurrent,
        outputDir,
        roundDir
      });
      roundRecord.steps.generate_bundle = "pass";
      roundRecord.bundle_path = generated.bundlePath;
      roundRecord.agent_mode = generated.mode || roundRecord.agent_mode;

      const loaded = await loadTemplateBundle(generated.bundlePath);
      const validateContext = await createRuntimeContext({
        bundleId: loaded.bundleId,
        bundlePath: loaded.bundlePath,
        bundleDir: loaded.bundleDir,
        bundle: loaded.bundle,
        baseUrl: options.baseUrl,
        dryRun: false
      });
      const validateReport = await runValidate(validateContext);
      roundRecord.validate_report = validateReport;
      roundRecord.steps.validate = validateReport.status === "pass" ? "pass" : "fail";

      const applyContext = await createRuntimeContext({
        bundleId: loaded.bundleId,
        bundlePath: loaded.bundlePath,
        bundleDir: loaded.bundleDir,
        bundle: loaded.bundle,
        baseUrl: options.baseUrl,
        dryRun
      });
      const applyReport = await runApply(applyContext);
      roundRecord.apply_report = applyReport;
      roundRecord.steps.apply = applyReport.status === "pass" ? "pass" : "fail";

      if (roundRecord.steps.apply === "pass" && scenario.kind === "workflow" && scenario.run_workflow && !dryRun) {
        const runtime = await observeWorkflowRun({
          baseUrl: options.baseUrl,
          runId: applyReport.created_resources?.workflow_run_id,
          tasks: loaded.bundle.workflow_template?.tasks ?? [],
          roleSessionPrefix: "campaign",
          maxPollSeconds
        });
        roundRecord.runtime = runtime;
        roundRecord.steps.run_observe = runtime.status === "pass" ? "pass" : "fail";
      }
    } catch (error) {
      roundRecord.error = toSafeError(error);
      if (roundRecord.steps.init === "pending") {
        roundRecord.steps.init = "fail";
      } else if (roundRecord.steps.generate_bundle === "pending") {
        roundRecord.steps.generate_bundle = "fail";
      } else if (roundRecord.steps.validate === "pending") {
        roundRecord.steps.validate = "fail";
      } else if (roundRecord.steps.apply === "pending") {
        roundRecord.steps.apply = "fail";
      } else if (roundRecord.steps.run_observe === "pending") {
        roundRecord.steps.run_observe = "fail";
      }
    }

    roundRecord.status = defaultRoundStatus(roundRecord);
    if (roundRecord.status !== "pass") {
      const stage =
        roundRecord.steps.validate !== "pass"
          ? "validate"
          : roundRecord.steps.apply !== "pass"
            ? "apply"
            : "runtime";
      const sourceError =
        roundRecord.error ||
        roundRecord.apply_report?.error ||
        roundRecord.validate_report?.error ||
        (roundRecord.runtime
          ? {
              code: "RUNTIME_NOT_CONVERGED",
              message: `runtime not converged: blocker_count=${roundRecord.runtime.blocker_count}`
            }
          : null);
      const category = categorizeFailure({
        stage,
        error: sourceError
      });
      roundRecord.failure_category = category;
      roundRecord.backend_suspect = category === "backend_suspect";
      const updates = deriveConstraintUpdates({ category, stage, error: sourceError });
      roundRecord.constraint_updates = updates;
      for (const rule of updates) {
        constraintEvolution.push({ round, scenario_id: scenario.id, rule });
      }
      if (updates.length > 0) {
        constraintPackCurrent = appendConstraintPack(constraintBase, constraintEvolution);
      }
    } else {
      const update = derivePassConstraintUpdate(scenario);
      roundRecord.constraint_updates = [update];
      constraintEvolution.push({ round, scenario_id: scenario.id, rule: update });
      constraintPackCurrent = appendConstraintPack(constraintBase, constraintEvolution);
    }

    await writeJsonFile(path.join(roundDir, "round_report.json"), roundRecord);
    await writeTextFile(path.join(roundDir, "round_report.md"), toRoundMarkdown(roundRecord));
    rounds.push(roundRecord);
  }

  const workflowRounds = rounds.filter((item) => item.scenario.kind === "workflow" && item.scenario.run_workflow && !dryRun);
  const workflowConverged = workflowRounds.filter((item) => item.steps.run_observe === "pass").length;
  const endedAt = new Date().toISOString();
  const summary = {
    total_rounds: rounds.length,
    pass_rounds: rounds.filter((item) => item.status === "pass").length,
    fail_rounds: rounds.filter((item) => item.status !== "pass").length,
    workflow_total: workflowRounds.length,
    workflow_converged: workflowConverged,
    workflow_convergence_rate: workflowRounds.length === 0 ? 0 : Number((workflowConverged / workflowRounds.length).toFixed(4)),
    top_failure_categories: topFailureCategories(rounds),
    backend_suspect_rounds: rounds.filter((item) => item.backend_suspect).map((item) => item.scenario.id)
  };

  const report = {
    campaign_id: manifest.campaign_id,
    name: manifest.name,
    run_id: runId,
    started_at: startedAt,
    ended_at: endedAt,
    dry_run: dryRun,
    base_url: options.baseUrl,
    manifest_path: manifestLoaded.manifestPath,
    output_dir: outputDir,
    summary,
    rounds,
    constraint_evolution: constraintEvolution
  };

  await writeJsonFile(path.join(outputDir, "campaign_report.json"), report);
  await writeTextFile(path.join(outputDir, "campaign_report.md"), toCampaignMarkdown(report));
  await writeTextFile(path.join(outputDir, "constraint-pack.evolved.md"), appendConstraintPack(constraintBase, constraintEvolution));

  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = ensureArg(args["base-url"], "base-url");
  const manifestPath = typeof args.manifest === "string" ? args.manifest : defaultManifestPath;
  const outputRoot =
    typeof args["output-root"] === "string"
      ? path.resolve(args["output-root"])
      : path.resolve(repoRoot, "agent-workspace/reports/campaign");
  const constraintPackPath =
    typeof args["constraint-pack"] === "string" ? path.resolve(args["constraint-pack"]) : defaultConstraintPackPath;
  const dryRun = Boolean(args["dry-run"]);
  const enforceStandardMix = !Boolean(args["allow-custom-mix"]);
  const maxPollSeconds = typeof args["max-poll-seconds"] === "string" ? Number(args["max-poll-seconds"]) : 10;
  const roundStart = typeof args["round-start"] === "string" ? Number(args["round-start"]) : 1;
  const agentMode = typeof args["agent-mode"] === "string" ? args["agent-mode"] : "simulated";
  if (agentMode === "real") {
    throw new AgentWorkspaceError(
      "campaign real mode was removed; use manual single-TemplateAgent flow for real verification",
      "CAMPAIGN_REAL_MODE_REMOVED"
    );
  }
  if (agentMode !== "simulated" && agentMode !== "internal") {
    throw new AgentWorkspaceError(
      `unknown campaign agent mode '${agentMode}', expected 'simulated' or 'internal'`,
      "CAMPAIGN_CLI_INPUT_INVALID"
    );
  }
  const bundleGenerator = simulateExternalSubagentBundle;

  const report = await runCampaign({
    baseUrl,
    manifestPath,
    outputRoot,
    constraintPackPath,
    dryRun,
    enforceStandardMix,
    maxPollSeconds,
    roundStart,
    bundleGenerator,
    runPrefix: "campaign"
  });

  console.log(`[agent-workspace:campaign] run_id=${report.run_id}`);
  console.log(`[agent-workspace:campaign] output_dir=${report.output_dir}`);
  console.log(
    `[agent-workspace:campaign] rounds=${report.summary.total_rounds} pass=${report.summary.pass_rounds} fail=${report.summary.fail_rounds}`
  );
  console.log(
    `[agent-workspace:campaign] workflow_converged=${report.summary.workflow_converged}/${report.summary.workflow_total}`
  );
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isEntrypoint) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[agent-workspace:campaign] error: ${message}`);
    if (error && typeof error === "object" && "details" in error && error.details) {
      console.error(JSON.stringify(error.details, null, 2));
    }
    process.exitCode = 1;
  });
}
