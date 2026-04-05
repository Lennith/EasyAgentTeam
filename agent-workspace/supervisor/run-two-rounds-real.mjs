#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTemplateBundle } from "../src/bundle-loader.mjs";
import { createRuntimeContext } from "../src/context.mjs";
import { runApply, runValidate } from "../src/engine.mjs";
import { AgentWorkspaceError } from "../src/errors.mjs";
import { initAgentWorkspace } from "../src/init-workspace.mjs";
import { readJsonFile, writeJsonFile, writeTextFile } from "../src/utils/file-utils.mjs";
import { requestJson } from "../src/utils/http-client.mjs";
import {
  checkArtifactsExistence,
  classifyRoundOutcome,
  deriveConstraintUpdateFromFailure,
  loadRunEventsFromDataRoot,
  renderRootCauseMarkdown,
  renderRoundResultMarkdown,
  summarizeEventEvidence,
  summarizeRuntimeStatus
} from "./real-supervisor-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

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
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new AgentWorkspaceError(`missing required argument: --${name}`, "SUPERVISOR_CLI_INPUT_INVALID");
  }
  return text;
}

function toRoundDirName(round, scenarioId) {
  return `round-${String(round).padStart(2, "0")}-${scenarioId}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sha256File(absolutePath) {
  const content = await fs.readFile(absolutePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function resolveSubmittedBundlePath(roundWorkspace, explicitBundlePath) {
  if (typeof explicitBundlePath === "string" && explicitBundlePath.trim().length > 0) {
    const resolved = path.resolve(explicitBundlePath.trim());
    try {
      await fs.access(resolved);
    } catch {
      throw new AgentWorkspaceError("bundle path not found for round", "SUPERVISOR_BUNDLE_NOT_FOUND", {
        bundle_path: resolved
      });
    }
    return resolved;
  }
  const bundleDir = path.join(roundWorkspace, "bundles");
  const files = await fs.readdir(bundleDir, { withFileTypes: true });
  const candidates = files
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .filter((name) => name !== "template.bundle.sample.json")
    .map((name) => path.join(bundleDir, name));
  if (candidates.length !== 1) {
    throw new AgentWorkspaceError(
      "round requires exactly one submitted bundle in template-agent workspace",
      "SUPERVISOR_BUNDLE_SUBMISSION_REQUIRED",
      {
        bundle_dir: bundleDir,
        candidate_count: candidates.length,
        candidates
      }
    );
  }
  return candidates[0];
}

async function resolvePublishReport(roundWorkspace, explicitPublishReportPath) {
  const candidate = explicitPublishReportPath
    ? path.resolve(explicitPublishReportPath)
    : path.join(roundWorkspace, "reports", "template-guard", "last_publish.json");
  try {
    await fs.access(candidate);
  } catch {
    return null;
  }
  const payload = await readJsonFile(candidate);
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return {
    publish_report_path: candidate,
    publish_report: payload
  };
}

async function waitRunObserved(baseUrl, runId, timeoutSeconds) {
  const timeoutMs = Math.max(10, Number(timeoutSeconds || 120)) * 1000;
  const deadline = Date.now() + timeoutMs;
  let statusPayload = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}/status`);
  let runtimePayload = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}/task-runtime`);
  while (Date.now() < deadline) {
    const statusText = String(statusPayload?.status ?? "").toLowerCase();
    if (statusText === "finished" || statusText === "failed" || statusText === "stopped") {
      return { timed_out: false, status_payload: statusPayload, runtime_payload: runtimePayload };
    }
    await sleep(1500);
    statusPayload = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}/status`);
    runtimePayload = await requestJson(baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}/task-runtime`);
  }
  return { timed_out: true, status_payload: statusPayload, runtime_payload: runtimePayload };
}

async function runOneRound(input) {
  const roundDir = path.resolve(input.roundDir);
  const templateWorkspace = path.join(roundDir, "template-agent-workspace");
  const scenario = input.scenario;
  const round = input.round;
  const roundGoal =
    Array.isArray(input.constraintUpdates) && input.constraintUpdates.length > 0
      ? `${scenario.goal}\n\nRound Constraint Updates:\n${input.constraintUpdates.map((item) => `- ${item}`).join("\n")}`
      : scenario.goal;

  await fs.mkdir(roundDir, { recursive: true });
  const initResult = await initAgentWorkspace({
    goal: roundGoal,
    baseUrl: input.baseUrl,
    workspaceRoot: templateWorkspace
  });

  function preRunFailure(category, reason, runId = null, extras = {}) {
    return {
      time: new Date().toISOString(),
      round,
      scenario_id: scenario.id,
      status: "fail",
      category,
      reason,
      run_id: runId,
      events: {
        events_total: 0,
        event_counts: {},
        has_dispatch_started: false,
        has_dispatch_finished: false,
        dispatch_started_count: 0,
        dispatch_finished_count: 0,
        task_report_applied_count: 0,
        fake_report_path: false,
        timeline: []
      },
      runtime: {
        run_status: "not_started",
        total_tasks: 0,
        done_tasks: 0,
        blocker_count: 0,
        all_done: false,
        task_states: {}
      },
      artifacts: {
        workspace_path: "",
        total_artifacts: 0,
        existing_artifacts: 0,
        missing_artifacts: 0,
        items: []
      },
      ...extras
    };
  }

  async function persistPreRunFailure(failed) {
    await writeJsonFile(path.join(roundDir, "event_evidence.json"), failed.events);
    await writeJsonFile(path.join(roundDir, "artifact_check.json"), failed.artifacts);
    await writeJsonFile(path.join(roundDir, "round_result.json"), failed);
    await writeTextFile(path.join(roundDir, "round_result.md"), renderRoundResultMarkdown(failed));
    await writeTextFile(path.join(roundDir, "root_cause.md"), renderRootCauseMarkdown(failed));
    return failed;
  }

  let runId = null;
  let bundlePath = "";
  let publishReportPath = "";

  const publishInfo = await resolvePublishReport(templateWorkspace, input.publishReportPath);
  if (publishInfo) {
    publishReportPath = publishInfo.publish_report_path;
    const published = publishInfo.publish_report;
    bundlePath = String(published.bundle_path ?? "");
    const submission = {
      time: new Date().toISOString(),
      round,
      scenario_id: scenario.id,
      template_workspace: templateWorkspace,
      submission_mode: "template_agent_publish",
      publish_report_path: publishReportPath,
      publish_status: String(published.status ?? ""),
      bundle_path: bundlePath || null,
      project_id: published.project_id ?? null,
      template_id: published.template_id ?? null,
      run_id: published.run_id ?? null
    };
    await writeJsonFile(path.join(roundDir, "submission.json"), submission);
    if (String(published.status ?? "").toLowerCase() !== "pass") {
      return persistPreRunFailure(
        preRunFailure("template_publish_failed", "TemplateAgent publish report is fail.", null, {
          publish_report_json: publishReportPath,
          publish_errors: Array.isArray(published.errors) ? published.errors : [],
          publish_hints: Array.isArray(published.hints) ? published.hints : []
        })
      );
    }
    runId = String(published.run_id ?? "").trim();
    if (!runId) {
      return persistPreRunFailure(
        preRunFailure("template_publish_failed", "TemplateAgent publish report missing run_id.", null, {
          publish_report_json: publishReportPath
        })
      );
    }
  } else {
    if (!input.controllerApply) {
      return persistPreRunFailure(
        preRunFailure(
          "template_publish_missing",
          "Missing TemplateAgent publish report. Require reports/template-guard/last_publish.json."
        )
      );
    }

    bundlePath = await resolveSubmittedBundlePath(templateWorkspace, input.bundlePath);
    const bundleHash = await sha256File(bundlePath);
    const submission = {
      time: new Date().toISOString(),
      round,
      scenario_id: scenario.id,
      bundle_path: bundlePath,
      bundle_sha256: bundleHash,
      template_workspace: templateWorkspace,
      submission_mode: "controller_apply_fallback"
    };
    await writeJsonFile(path.join(roundDir, "submission.json"), submission);

    const loaded = await loadTemplateBundle(bundlePath);
    const validateContext = await createRuntimeContext({
      bundleId: loaded.bundleId,
      bundlePath: loaded.bundlePath,
      bundleDir: loaded.bundleDir,
      bundle: loaded.bundle,
      baseUrl: input.baseUrl,
      dryRun: false
    });
    const validateReport = await runValidate(validateContext);
    await writeJsonFile(path.join(roundDir, "validate_report.json"), validateReport);
    if (validateReport.status !== "pass") {
      return persistPreRunFailure(preRunFailure("template_validation_failed", "bundle validation failed before apply"));
    }

    const applyContext = await createRuntimeContext({
      bundleId: loaded.bundleId,
      bundlePath: loaded.bundlePath,
      bundleDir: loaded.bundleDir,
      bundle: loaded.bundle,
      baseUrl: input.baseUrl,
      dryRun: false
    });
    const applyReport = await runApply(applyContext);
    await writeJsonFile(path.join(roundDir, "apply_report.json"), applyReport);
    if (applyReport.status !== "pass" || !applyReport.created_resources?.workflow_run_id) {
      return persistPreRunFailure(
        preRunFailure(
          "apply_failed",
          "bundle apply failed or workflow run id missing",
          applyReport.created_resources?.workflow_run_id ?? null
        )
      );
    }
    runId = String(applyReport.created_resources.workflow_run_id);
  }
  await requestJson(input.baseUrl, "POST", `/api/workflow-runs/${encodeURIComponent(runId)}/start`, {}, [200]);
  const observed = await waitRunObserved(input.baseUrl, runId, input.timeoutSeconds);
  const runDetail = await requestJson(input.baseUrl, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`, undefined, [
    200
  ]);
  const loadedEvents = await loadRunEventsFromDataRoot(input.dataRoot, runId);
  const eventEvidence = summarizeEventEvidence(loadedEvents.events);
  const runtimeSummary = summarizeRuntimeStatus(observed.status_payload, observed.runtime_payload);
  const artifactCheck = await checkArtifactsExistence(runDetail?.tasks ?? [], String(runDetail?.workspacePath ?? ""));
  const judged = classifyRoundOutcome({
    eventEvidence,
    runtimeSummary,
    artifactCheck
  });
  const reason = observed.timed_out
    ? `${judged.reason} Observation timed out before terminal run status.`
    : judged.reason;
  const result = {
    time: new Date().toISOString(),
    round,
    scenario_id: scenario.id,
    scenario_goal: scenario.goal,
    status: judged.status,
    category: judged.category,
    reason,
    run_id: runId,
    bundle_path: bundlePath,
    init_report_json: initResult.reportJsonPath,
    publish_report_json: publishReportPath || null,
    validate_report_json: publishReportPath ? null : path.join(roundDir, "validate_report.json"),
    apply_report_json: publishReportPath ? null : path.join(roundDir, "apply_report.json"),
    events: {
      ...eventEvidence,
      events_path: loadedEvents.events_path
    },
    runtime: {
      ...runtimeSummary,
      observed_timed_out: observed.timed_out
    },
    artifacts: artifactCheck
  };
  await writeJsonFile(path.join(roundDir, "event_evidence.json"), result.events);
  await writeJsonFile(path.join(roundDir, "artifact_check.json"), artifactCheck);
  await writeJsonFile(path.join(roundDir, "round_result.json"), result);
  await writeTextFile(path.join(roundDir, "round_result.md"), renderRoundResultMarkdown(result));
  await writeTextFile(path.join(roundDir, "root_cause.md"), renderRootCauseMarkdown(result));
  return result;
}

function renderCampaignMarkdown(summary) {
  const lines = [];
  lines.push("# Real Two-Round Supervisor Report");
  lines.push("");
  lines.push(`- run_id: ${summary.run_id}`);
  lines.push(`- output_root: ${summary.output_root}`);
  lines.push(`- rounds_total: ${summary.rounds_total}`);
  lines.push(`- pass_rounds: ${summary.pass_rounds}`);
  lines.push(`- fail_rounds: ${summary.fail_rounds}`);
  lines.push(`- convergence_rate: ${summary.convergence_rate}`);
  lines.push("");
  lines.push("## Round Results");
  for (const round of summary.rounds) {
    lines.push(
      `- round ${round.round} (${round.scenario_id}): ${round.status} [${round.category}] run_id=${round.run_id || "n/a"}`
    );
  }
  lines.push("");
  lines.push("## Constraint Evolution");
  if (summary.constraint_evolution.length === 0) {
    lines.push("- (none)");
  } else {
    for (const item of summary.constraint_evolution) {
      lines.push(`- [round ${item.round}] ${item.rule}`);
    }
  }
  lines.push("");
  return `${lines.join("\n").trim()}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = ensureArg(args["base-url"], "base-url");
  const manifestPath =
    typeof args.manifest === "string"
      ? path.resolve(args.manifest)
      : path.resolve(__dirname, "scenarios.two-rounds.json");
  const dataRoot = typeof args["data-root"] === "string" ? path.resolve(args["data-root"]) : path.resolve(repoRoot, "data");
  const timeoutSeconds = Number.isFinite(Number(args["timeout-seconds"])) ? Number(args["timeout-seconds"]) : 120;
  const controllerApply = Boolean(args["controller-apply"]);
  const outputRootBase =
    typeof args["output-root"] === "string"
      ? path.resolve(args["output-root"])
      : path.resolve(repoRoot, "agent-workspace", "reports", "real-two-rounds");
  const runId = `real-two-rounds-${nowStamp()}`;
  const outputRoot = path.join(outputRootBase, runId);
  await fs.mkdir(outputRoot, { recursive: true });

  const manifest = await readJsonFile(manifestPath);
  const scenarios = Array.isArray(manifest?.scenarios) ? manifest.scenarios : [];
  if (scenarios.length !== 2) {
    throw new AgentWorkspaceError("two-round supervisor requires exactly 2 scenarios", "SUPERVISOR_SCENARIO_INVALID", {
      manifest_path: manifestPath,
      scenario_count: scenarios.length
    });
  }

  const perRoundBundle = [args["round-1-bundle"], args["round-2-bundle"]];
  const perRoundPublish = [args["round-1-publish"], args["round-2-publish"]];
  const rounds = [];
  const constraintEvolution = [];
  let currentConstraintUpdates = [];
  for (let index = 0; index < scenarios.length; index += 1) {
    const round = index + 1;
    const scenario = scenarios[index];
    const roundDir = path.join(outputRoot, toRoundDirName(round, String(scenario?.id ?? `round_${round}`)));
    const result = await runOneRound({
      round,
      scenario,
      roundDir,
      bundlePath: typeof perRoundBundle[index] === "string" ? perRoundBundle[index] : "",
      publishReportPath: typeof perRoundPublish[index] === "string" ? perRoundPublish[index] : "",
      controllerApply,
      baseUrl,
      dataRoot,
      timeoutSeconds,
      constraintUpdates: currentConstraintUpdates
    });
    rounds.push(result);
    if (result.status !== "pass") {
      const rule = deriveConstraintUpdateFromFailure(result.category);
      constraintEvolution.push({ round, scenario_id: scenario.id, rule });
      currentConstraintUpdates = [rule];
    } else {
      currentConstraintUpdates = [];
    }
  }

  const passRounds = rounds.filter((item) => item.status === "pass").length;
  const summary = {
    generated_at: new Date().toISOString(),
    run_id: runId,
    output_root: outputRoot,
    manifest_path: manifestPath,
    base_url: baseUrl,
    data_root: dataRoot,
    rounds_total: rounds.length,
    pass_rounds: passRounds,
    fail_rounds: rounds.length - passRounds,
    convergence_rate: rounds.length === 0 ? 0 : Number((passRounds / rounds.length).toFixed(4)),
    rounds: rounds.map((item) => ({
      round: item.round,
      scenario_id: item.scenario_id,
      status: item.status,
      category: item.category,
      run_id: item.run_id,
      dispatch_started: item.events.dispatch_started_count,
      dispatch_finished: item.events.dispatch_finished_count,
      missing_artifacts: item.artifacts.missing_artifacts,
      blocker_count: item.runtime.blocker_count
    })),
    constraint_evolution: constraintEvolution
  };

  await writeJsonFile(path.join(outputRoot, "campaign_report.json"), summary);
  await writeTextFile(path.join(outputRoot, "campaign_report.md"), renderCampaignMarkdown(summary));
  console.log(`[real-two-rounds] run_id=${runId}`);
  console.log(`[real-two-rounds] output_root=${outputRoot}`);
  console.log(`[real-two-rounds] pass=${summary.pass_rounds} fail=${summary.fail_rounds}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[real-two-rounds] error: ${message}`);
  if (error && typeof error === "object" && "details" in error && error.details) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exitCode = 1;
});
